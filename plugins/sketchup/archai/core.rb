# ArchAI plugin core for SketchUp: the Ruby twin of plugins/python/archai_core.py (binary glTF,
# the exchange file ArchAI opens, .AIR import through ArchAI's 3D snapshot, VR tours).
# ArchAI units: millimetres, plan x right, plan y down (a Z-up right-handed host's -Y), elevation up.
# glTF, ArchAI's 3D scene and the VR viewer: metres, (x, up, plan y).
require 'json'
require 'base64'

module ArchAI
  module Core
    VERSION = '0.4.1'.freeze
    WEB_URL = 'https://archai-studio-six.vercel.app/'.freeze
    DEFAULT_SHARE_URL = 'https://archai-vr-share.mklkoklpp.workers.dev'.freeze
    MAX_MODEL_BYTES = 95 * 1024 * 1024
    MAX_STOPS = 40
    LOOK_DISTANCE = 3.0
    EYE_HEIGHT = 1.6
    NO_SNAPSHOT = 'This .AIR file has no 3D model saved in it. Open it in ArchAI (0.2.2.8 or later) and save it once, then import it again.'.freeze

    # A glTF metallic-roughness material; colours are sRGB 0..1.
    class Material
      attr_reader :name, :r, :g, :b, :opacity, :roughness, :metalness

      def initialize(name, r = 0.8, g = 0.8, b = 0.8, opacity = 1.0, roughness = 0.8, metalness = 0.0)
        @name = (name.nil? || name.empty?) ? 'Material' : name
        @r, @g, @b = r.to_f, g.to_f, b.to_f
        @opacity, @roughness, @metalness = opacity.to_f, roughness.to_f, metalness.to_f
      end
    end

    DEFAULT_MATERIAL = Material.new('Default', 0.78, 0.79, 0.81)

    # Progress in SketchUp's status bar (its Ruby API has no progress bar for extensions): the
    # step and, when the amount of work is known, a text bar with the percentage.
    #   progress = Core::Progress.new('Send to ArchAI'); report = progress.method(:update)
    class Progress
      WIDTH = 20

      def initialize(title)
        @title = title
      end

      def update(text, fraction = nil)
        line = "ArchAI #{@title}: #{text}"
        if fraction
          f = [[fraction.to_f, 0.0].max, 1.0].min
          filled = (f * WIDTH).round
          line = "#{line}   [#{'#' * filled}#{'-' * (WIDTH - filled)}] #{(f * 100).round}%"
        end
        Sketchup.status_text = line if defined?(Sketchup)
      end

      def finish
        Sketchup.status_text = '' if defined?(Sketchup)
      end
    end

    # A report(text, fraction) whose 0..1 lands in [from, to] of `report`.
    def self.scaled(report, from, to)
      return nil unless report
      ->(text, fraction = nil) { report.call(text, fraction.nil? ? nil : from + (to - from) * fraction) }
    end

    # Item `index` of `count` done (at most about 50 reports per run).
    def self.step(report, index, count, text)
      return if report.nil? || count <= 0
      stride = [1, count / 50].max
      report.call(text, index.to_f / count) if (index % stride).zero? || index == count - 1
    end

    def self.linear(c)
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055)**2.4
    end

    def self.srgb(c)
      c <= 0.0031308 ? c * 12.92 : 1.055 * c**(1 / 2.4) - 0.055
    end

    # Triangles of one material: flat positions (ArchAI mm) and flat triangle indices.
    class Part
      attr_reader :material, :positions, :indices

      def initialize(material)
        @material = material
        @positions = []
        @indices = []
      end
    end

    # One host object to send to ArchAI or to VR.
    class SceneObject
      # archai: the ArchAI element this object is an editable copy of (Live Bridge); was: an older id.
      attr_accessor :id, :name, :category, :archai, :was
      attr_reader :parts

      def initialize(id, name, category = '')
        @id, @name, @category = id, name, category
        @parts = {}
        @archai = nil
        @was = nil
      end

      def add_mesh(material, positions, indices)
        part = (@parts[material.name] ||= Part.new(material))
        base = part.positions.length / 3
        part.positions.concat(positions)
        part.indices.concat(indices.map { |i| i + base })
      end

      def triangle_count
        @parts.values.sum { |p| p.indices.length / 3 }
      end
    end

    def self.from_z_up(x, y, z, millimetres)
      [x * millimetres, -y * millimetres, z * millimetres]
    end

    def self.to_z_up(x, y, z, millimetres)
      [x * 1000.0 / millimetres, -z * 1000.0 / millimetres, y * 1000.0 / millimetres]
    end

    class Bounds
      attr_reader :min, :max

      def initialize
        @min = [Float::INFINITY] * 3
        @max = [-Float::INFINITY] * 3
      end

      def empty?
        @min[0] > @max[0]
      end

      def add(positions)
        positions.each_with_index do |v, i|
          a = i % 3
          @min[a] = v if v < @min[a]
          @max[a] = v if v > @max[a]
        end
      end

      def self.of(objects)
        bounds = Bounds.new
        objects.each { |o| o.parts.each_value { |p| bounds.add(p.positions) unless p.indices.empty? } }
        bounds
      end
    end

    # ---- binary glTF -------------------------------------------------------------------------

    class GlbWriter
      attr_reader :triangle_count

      def initialize
        @nodes = []
        @triangle_count = 0
      end

      def begin_node(name, extras = nil)
        @nodes << { name: name.to_s, extras: extras, parts: {} }
      end

      def add(material, positions, indices)
        begin_node('') if @nodes.empty?
        part = (@nodes.last[:parts][material.name] ||= [material, [], []])
        base = part[1].length / 3
        part[1].concat(positions)
        part[2].concat(indices.map { |i| i + base })
        @triangle_count += indices.length / 3
      end

      def to_glb(generator = 'ArchAI plugin')
        binary = String.new(encoding: Encoding::BINARY)
        views, accessors, meshes, nodes, materials, material_index = [], [], [], [], [], {}
        @nodes.each do |node|
          primitives = []
          node[:parts].each_value do |material, positions, indices|
            next if indices.empty?
            mins = (0..2).map { |a| positions.each_slice(3).map { |p| p[a] }.min }
            maxs = (0..2).map { |a| positions.each_slice(3).map { |p| p[a] }.max }
            views << { 'buffer' => 0, 'byteOffset' => binary.bytesize, 'byteLength' => positions.length * 4, 'target' => 34962 }
            binary << positions.pack('e*')
            accessors << { 'bufferView' => views.length - 1, 'componentType' => 5126, 'count' => positions.length / 3, 'type' => 'VEC3', 'min' => mins, 'max' => maxs }
            position_accessor = accessors.length - 1
            views << { 'buffer' => 0, 'byteOffset' => binary.bytesize, 'byteLength' => indices.length * 4, 'target' => 34963 }
            binary << indices.pack('V*')
            accessors << { 'bufferView' => views.length - 1, 'componentType' => 5125, 'count' => indices.length, 'type' => 'SCALAR' }
            unless material_index.key?(material.name)
              entry = { 'name' => material.name, 'doubleSided' => true, 'pbrMetallicRoughness' => {
                'baseColorFactor' => [Core.linear(material.r), Core.linear(material.g), Core.linear(material.b), material.opacity],
                'metallicFactor' => material.metalness, 'roughnessFactor' => material.roughness } }
              entry['alphaMode'] = 'BLEND' if material.opacity < 0.999
              materials << entry
              material_index[material.name] = materials.length - 1
            end
            primitives << { 'attributes' => { 'POSITION' => position_accessor }, 'indices' => accessors.length - 1, 'material' => material_index[material.name], 'mode' => 4 }
          end
          next if primitives.empty?
          meshes << { 'name' => node[:name], 'primitives' => primitives }
          gltf_node = { 'mesh' => meshes.length - 1 }
          gltf_node['name'] = node[:name] unless node[:name].empty?
          gltf_node['extras'] = node[:extras] if node[:extras]
          nodes << gltf_node
        end
        document = {
          'asset' => { 'version' => '2.0', 'generator' => generator }, 'scene' => 0,
          'scenes' => [{ 'nodes' => (0...nodes.length).to_a }], 'nodes' => nodes, 'meshes' => meshes,
          'materials' => materials, 'accessors' => accessors, 'bufferViews' => views,
          'buffers' => [{ 'byteLength' => binary.bytesize }]
        }
        text = JSON.generate(document).dup.force_encoding(Encoding::BINARY)
        text << (' ' * ((4 - text.bytesize % 4) % 4))
        binary << ("\0" * ((4 - binary.bytesize % 4) % 4))
        [0x46546C67, 2, 12 + 8 + text.bytesize + 8 + binary.bytesize].pack('V3') +
          [text.bytesize, 0x4E4F534A].pack('V2') + text +
          [binary.bytesize, 0x004E4942].pack('V2') + binary
      end
    end

    ImportPart = Struct.new(:material, :positions, :indices)

    class ImportObject
      # archai: ArchAI's node extras (id, and in Live Bridge pulls hash, source, color, editable, ref).
      attr_accessor :name, :level, :type, :archai
      attr_reader :parts

      def initialize(name, level = '', type = '')
        @name, @level, @type = name, level, type
        @parts = []
        @archai = {}
      end
    end

    FORMATS = { 5126 => ['e', 4], 5125 => ['V', 4], 5123 => ['v', 2], 5122 => ['s<', 2], 5121 => ['C', 1], 5120 => ['c', 1] }.freeze
    COMPONENTS = { 'SCALAR' => 1, 'VEC2' => 2, 'VEC3' => 3, 'VEC4' => 4 }.freeze
    IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0].freeze

    # Objects of a binary glTF in world coordinates; nodes with extras.archai are one object each.
    def self.read_glb(data)
      data = data.b
      raise ArgumentError, 'Not a binary glTF file.' if data.bytesize < 20 || data[0, 4].unpack1('V') != 0x46546C67
      gltf = nil
      binary = ''.b
      offset = 12
      while offset + 8 <= data.bytesize
        length, kind = data[offset, 8].unpack('V2')
        chunk = data[offset + 8, length]
        gltf = JSON.parse(chunk.force_encoding(Encoding::UTF_8)) if kind == 0x4E4F534A
        binary = chunk if kind == 0x004E4942
        offset += 8 + length
      end
      raise ArgumentError, 'The glTF file has no JSON chunk.' unless gltf
      GltfScene.new(gltf, binary).objects
    end

    # A Live Bridge pull: [objects, bridge] where bridge is the root's archaiBridge extras.
    def self.read_bridge_glb(data)
      objects = read_glb(data)
      bytes = data.b
      length = bytes[12, 4].unpack1('V')
      gltf = JSON.parse(bytes[20, length].force_encoding(Encoding::UTF_8))
      node = (gltf['nodes'] || []).find { |n| (n['extras'] || {})['archaiBridge'].is_a?(Hash) }
      [objects, node ? node['extras']['archaiBridge'] : {}]
    end

    # A Live Bridge move (ArchAI plan mm: x right, plan y down, elevation) as a Z-up host vector.
    def self.move_to_z_up(move, millimetres)
      [move[0] / millimetres, -move[1] / millimetres, move[2] / millimetres]
    end

    # What this computer remembers of each model's Live Bridge link (shared with the other plugins).
    def self.bridge_file
      File.join(ENV['LOCALAPPDATA'] || File.join(Dir.home, '.local', 'share'), 'ArchAI', 'live-bridge.json')
    end

    def self.bridge_entry(key)
      state = JSON.parse(File.read(bridge_file, encoding: 'UTF-8'))
      state.is_a?(Hash) && state[key].is_a?(Hash) ? state[key] : {}
    rescue StandardError
      {}
    end

    def self.remember_bridge(key, entry)
      state = begin
        JSON.parse(File.read(bridge_file, encoding: 'UTF-8'))
      rescue StandardError
        {}
      end
      state = {} unless state.is_a?(Hash)
      if entry then state[key] = entry else state.delete(key) end
      Dir.mkdir(File.dirname(bridge_file)) unless File.directory?(File.dirname(bridge_file))
      File.write(bridge_file, JSON.generate(state))
    rescue StandardError
      nil
    end

    class GltfScene
      def initialize(gltf, binary)
        @gltf, @binary = gltf, binary
        @nodes = gltf['nodes'] || []
        @tagged = @nodes.any? { |n| (n['extras'] || {})['archai'].is_a?(Hash) }
        @materials = {}
        @result = []
      end

      def objects
        scenes = @gltf['scenes'] || [{ 'nodes' => (0...@nodes.length).to_a }]
        (scenes[@gltf['scene'] || 0]['nodes'] || []).each { |root| visit(root, IDENTITY, nil) }
        @result.reject { |o| o.parts.empty? }
      end

      def visit(index, parent, owner)
        node = @nodes[index]
        world = Core.multiply(parent, Core.local(node))
        archai = (node['extras'] || {})['archai']
        if archai.is_a?(Hash) || (!@tagged && node.key?('mesh') && owner.nil?)
          archai = {} unless archai.is_a?(Hash)
          name = node['name'].to_s
          name = @gltf['meshes'][node['mesh']]['name'].to_s if name.empty? && node.key?('mesh')
          kind = (archai['type'] || archai['kind'] || '').to_s
          owner = ImportObject.new(name.empty? ? (kind.empty? ? 'Object' : kind) : name, archai['level'].to_s, kind)
          owner.archai = archai
          @result << owner
        end
        add_mesh(node['mesh'], world, owner) if node.key?('mesh') && owner
        (node['children'] || []).each { |child| visit(child, world, @tagged ? owner : nil) }
      end

      def accessor(index)
        accessor = @gltf['accessors'][index]
        view = @gltf['bufferViews'][accessor['bufferView']]
        code, size = FORMATS[accessor['componentType']]
        components = COMPONENTS[accessor['type']]
        start = (view['byteOffset'] || 0) + (accessor['byteOffset'] || 0)
        stride = view['byteStride'] || size * components
        values = []
        accessor['count'].times do |i|
          values.concat(@binary[start + i * stride, size * components].unpack("#{code}#{components}"))
        end
        values
      end

      def add_mesh(index, m, owner)
        mirrored = Core.determinant(m) < 0
        (@gltf['meshes'][index]['primitives'] || []).each do |primitive|
          next if (primitive['mode'] || 4) != 4 || !primitive['attributes'].key?('POSITION')
          local = accessor(primitive['attributes']['POSITION'])
          positions = []
          local.each_slice(3) do |x, y, z|
            positions << m[0] * x + m[4] * y + m[8] * z + m[12]
            positions << m[1] * x + m[5] * y + m[9] * z + m[13]
            positions << m[2] * x + m[6] * y + m[10] * z + m[14]
          end
          indices = primitive.key?('indices') ? accessor(primitive['indices']).map(&:to_i) : (0...(local.length / 3)).to_a
          if mirrored
            (0...(indices.length / 3)).each { |t| indices[t * 3 + 1], indices[t * 3 + 2] = indices[t * 3 + 2], indices[t * 3 + 1] }
          end
          owner.parts << ImportPart.new(material(primitive['material']), positions, indices)
        end
      end

      def material(index)
        return DEFAULT_MATERIAL if index.nil?
        @materials[index] ||= begin
          source = @gltf['materials'][index]
          pbr = source['pbrMetallicRoughness'] || {}
          f = pbr['baseColorFactor'] || [1, 1, 1, 1]
          Material.new(source['name'] || "Material #{index}", Core.srgb(f[0]), Core.srgb(f[1]), Core.srgb(f[2]),
                       source['alphaMode'] == 'BLEND' ? f[3] : 1.0, pbr['roughnessFactor'] || 1.0, pbr['metallicFactor'] || 1.0)
        end
      end
    end

    def self.multiply(a, b)
      result = Array.new(16, 0.0)
      4.times do |col|
        4.times do |row|
          result[col * 4 + row] = (0..3).sum { |k| a[k * 4 + row] * b[col * 4 + k] }
        end
      end
      result
    end

    def self.determinant(m)
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
    end

    def self.local(node)
      return node['matrix'].map(&:to_f) if node['matrix']
      tx, ty, tz = node['translation'] || [0, 0, 0]
      qx, qy, qz, qw = node['rotation'] || [0, 0, 0, 1]
      sx, sy, sz = node['scale'] || [1, 1, 1]
      x2, y2, z2 = qx + qx, qy + qy, qz + qz
      xx, xy, xz, yy, yz, zz = qx * x2, qx * y2, qx * z2, qy * y2, qy * z2, qz * z2
      wx, wy, wz = qw * x2, qw * y2, qw * z2
      [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
       (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
       (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
       tx, ty, tz, 1].map(&:to_f)
    end

    # ---- exchange file and .AIR import -----------------------------------------------------------

    def self.truncate(text, length)
      text.to_s[0, length]
    end

    def self.write_exchange(name, app, app_version, source, objects)
      meshes = []
      objects.each_with_index do |o, number|
        parts = o.parts.values.reject { |p| p.indices.empty? }
        next if parts.empty?
        box = Bounds.new
        parts.each { |p| box.add(p.positions) }
        writer = GlbWriter.new
        parts.each do |p|
          local = []
          p.positions.each_slice(3) { |x, y, z| local.push(x - box.min[0], z - box.min[2], y - box.min[1]) }
          flipped = []
          p.indices.each_slice(3) { |a, b, c| flipped.push(a, c, b) }
          writer.add(p.material, local, flipped)
        end
        meshes << {
          'id' => truncate(o.id.to_s.empty? ? "o#{number + 1}" : o.id, 64), 'name' => truncate(o.name, 120),
          'category' => truncate(o.category, 80), 'level' => nil,
          'origin' => box.min.map { |v| v.round(1) }, 'size' => (0..2).map { |a| (box.max[a] - box.min[a]).round(1) },
          'glb' => Base64.strict_encode64(writer.to_glb("ArchAI #{app} plugin"))
        }
        meshes.last['archai'] = truncate(o.archai, 64) if o.respond_to?(:archai) && o.archai && !o.archai.to_s.empty?
        meshes.last['was'] = truncate(o.was, 64) if o.respond_to?(:was) && o.was && o.was.to_s != o.id.to_s
      end
      { 'archaiRevit' => 1, 'app' => app, 'name' => truncate(name.to_s.empty? ? "#{app} model" : name, 200),
        'source' => truncate(source, 1000), 'revitVersion' => truncate("#{app} #{app_version}", 40),
        'materials' => [], 'levels' => [], 'meshes' => meshes }
    end

    # [name, objects] of an .AIR file in world glTF metres (x, up, plan y).
    def self.read_air(path)
      root = begin
        JSON.parse(File.read(path, encoding: 'UTF-8'))
      rescue JSON::ParserError
        raise ArgumentError, "#{File.basename(path)} is not an ArchAI .AIR file."
      end
      name = File.basename(path, '.*')
      if root.is_a?(Hash) && root.key?('archaiRevit')
        levels = (root['levels'] || []).map { |l| [l['id'], l['name'].to_s] }.to_h
        objects = []
        (root['meshes'] || []).each do |mesh|
          origin = mesh['origin']
          next if mesh['glb'].nil? || origin.nil? || origin.length < 3
          item = ImportObject.new((mesh['name'].to_s.empty? ? mesh['category'] : mesh['name']).to_s, levels[mesh['level']].to_s, mesh['category'].to_s)
          read_glb(Base64.decode64(mesh['glb'])).each do |read|
            read.parts.each do |part|
              world = []
              part.positions.each_slice(3) { |x, y, z| world.push((x + origin[0]) / 1000.0, (y + origin[2]) / 1000.0, (z + origin[1]) / 1000.0) }
              flipped = []
              part.indices.each_slice(3) { |a, b, c| flipped.push(a, c, b) }
              item.parts << ImportPart.new(part.material, world, flipped)
            end
          end
          objects << item unless item.parts.empty?
        end
        return [root['name'] || name, objects]
      end
      raise ArgumentError, "#{File.basename(path)} is not an ArchAI .AIR file." unless root.is_a?(Hash) && root.key?('schemaVersion')
      name = (root['meta'] || {})['name'] || name
      data = (root['scene3d'] || {})['data']
      raise ArgumentError, NO_SNAPSHOT unless data.is_a?(String)
      [name, read_glb(Base64.decode64(data))]
    end

    def self.by_level(objects)
      groups = objects.group_by { |o| o.level.to_s }
      groups.sort_by do |level, items|
        heights = items.flat_map { |o| o.parts.flat_map { |p| p.positions.each_slice(3).map { |v| v[1] } } }
        [level.empty? ? 1 : 0, heights.min || 0]
      end
    end

    # ---- VR tours ------------------------------------------------------------------------------

    VrStop = Struct.new(:id, :name, :x, :z, :floor, :look_x, :look_z)

    def self.camera_stop(name, eye_mm, direction, floor_mm = nil)
      x, z = eye_mm[0] / 1000.0, eye_mm[1] / 1000.0
      dx, dz = direction[0], direction[1]
      length = Math.hypot(dx, dz)
      dx, dz, length = 1.0, 0.0, 1.0 if length < 1e-9
      floor = floor_mm ? floor_mm / 1000.0 : eye_mm[2] / 1000.0 - EYE_HEIGHT
      VrStop.new('', truncate(name.to_s.strip.empty? ? 'View' : name.to_s.strip, 120), x, z, floor, x + dx / length * LOOK_DISTANCE, z + dz / length * LOOK_DISTANCE)
    end

    def self.outside_stop(bounds)
      cx, cz = (bounds.min[0] + bounds.max[0]) / 2000.0, (bounds.min[1] + bounds.max[1]) / 2000.0
      back = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]].max / 2000.0 + 5
      VrStop.new('', 'Outside', cx, cz + back, bounds.min[2] / 1000.0, cx, cz)
    end

    def self.vr_model(objects, bounds, generator)
      writer = GlbWriter.new
      objects.each do |o|
        parts = o.parts.values.reject { |p| p.indices.empty? }
        next if parts.empty?
        writer.begin_node(o.name)
        parts.each do |p|
          gltf = []
          p.positions.each_slice(3) { |x, y, z| gltf.push(x / 1000.0, z / 1000.0, y / 1000.0) }
          writer.add(p.material, gltf, p.indices)
        end
      end
      unless bounds.empty?
        cx, cz = (bounds.min[0] + bounds.max[0]) / 2000.0, (bounds.min[1] + bounds.max[1]) / 2000.0
        radius = [[bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]].max / 2000.0 * 4, 60].max
        y = bounds.min[2] / 1000.0 - 0.025
        positions = [cx, y, cz]
        indices = []
        64.times do |i|
          a = 2 * Math::PI * i / 64
          positions.push(cx + Math.cos(a) * radius, y, cz + Math.sin(a) * radius)
          indices.push(0, 1 + (i + 1) % 64, 1 + i)
        end
        writer.begin_node('Ground')
        writer.add(Material.new('Ground', 0xd9 / 255.0, 0xdb / 255.0, 0xd5 / 255.0, 1.0, 1.0), positions, indices)
      end
      writer
    end

    # [glb, tour, triangles, stops]; glb is nil when there is nothing to show.
    def self.build_tour(name, app, objects, cameras, start_camera = nil)
      bounds = Bounds.of(objects)
      return [nil, nil, 0, 0] if bounds.empty?
      writer = vr_model(objects, bounds, "ArchAI #{app} plugin")
      stops = cameras.first(MAX_STOPS)
      stops = [outside_stop(bounds)] if stops.empty?
      stops.each_with_index { |s, i| s.id = "s#{i + 1}" }
      start = stops.find { |s| s.name == start_camera } || stops.first
      tour = {
        'format' => 'archai-vr', 'version' => 1, 'name' => truncate(name, 120),
        'model' => "model.glb?v=#{Time.now.utc.strftime('%Y%m%d%H%M%S')}",
        'lighting' => 'live', 'exposure' => 1.1, 'credit' => "#{app} model via ArchAI", 'start' => start.id,
        'spaces' => stops.map { |s| { 'id' => s.id, 'name' => s.name, 'center' => [s.x.round(3), s.z.round(3)], 'look' => [s.look_x.round(3), s.look_z.round(3)], 'floor' => s.floor.round(3) } }
      }
      [writer.to_glb("ArchAI #{app} plugin"), tour, writer.triangle_count, stops.length]
    end

    # ---- the share service -----------------------------------------------------------------------

    # [url, token]: the share service and the ArchAI account to publish with, or nil. Publishing
    # needs an account: the extension asks the ArchAI desktop app for the signed-in session over
    # the Live Bridge (GET /live/account, see electron/liveLink.ts). When nobody is signed in,
    # ArchAI comes to the front with its sign-in dialog; when it is not running it is started.
    # Core.no_key then says what to do. ARCHAI_VR_SHARE_URL overrides the service.
    def self.share_config(app = 'SketchUp')
      require 'net/http'
      url = ENV['ARCHAI_VR_SHARE_URL'].to_s.strip
      url = DEFAULT_SHARE_URL if url.empty?
      port = ENV['ARCHAI_LIVE_PORT'].to_s =~ /\A\d+\z/ ? ENV['ARCHAI_LIVE_PORT'].to_i : 47821
      begin
        http = Net::HTTP.new('127.0.0.1', port)
        http.open_timeout = 2
        http.read_timeout = 20
        req = Net::HTTP::Get.new("/live/account?prompt=1&app=#{URI.encode_www_form_component(app)}")
        req['X-ArchAI-Live'] = '1'
        account = JSON.parse(http.request(req).body.to_s)
        token = account['token'].to_s
        return [url.chomp('/'), token] if account['signedIn'] && !token.empty?
        @no_key = 'Open in VR publishes with your ArchAI account. Sign in in ArchAI (it is asking now), then run Open in VR again.'
      rescue StandardError
        started = defined?(ArchAI::Live) ? ArchAI::Live.launch('') : false
        @no_key = started ?
          'Open in VR publishes with your ArchAI account. ArchAI is starting: sign in there (top right), then run Open in VR again.' :
          'Open in VR publishes with your ArchAI account: install and start the ArchAI desktop app, sign in (top right), then run Open in VR again.'
      end
      nil
    end

    # Why share_config returned nil.
    def self.no_key
      @no_key || 'Open in VR publishes with your ArchAI account: start ArchAI and sign in (top right).'
    end

    def self.links_file
      base = ENV['LOCALAPPDATA'] || File.join(Dir.home, '.local', 'share')
      File.join(base, 'ArchAI', 'vr-links.json')
    end

    def self.links
      JSON.parse(File.read(links_file))
    rescue StandardError
      {}
    end

    def self.remember(key, id)
      all = links
      all[key] = id
      require 'fileutils'
      FileUtils.mkdir_p(File.dirname(links_file))
      File.write(links_file, JSON.pretty_generate(all))
    rescue StandardError
      nil
    end

    def self.vr_message(name, triangles, stops, link)
      heavy = triangles > 1_000_000 ? "\n\n#{triangles} triangles is a lot for a standalone headset; hide detail you do not need and publish again." : ''
      "#{name} is online with #{stops} stop#{stops == 1 ? '' : 's'} (#{triangles} triangles).\n\nOn the headset, open this link in the browser and press Enter VR:\n#{link}\n\nPublishing this model again updates the same link.#{heavy}"
    end
  end
end
