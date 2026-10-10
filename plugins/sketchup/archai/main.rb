# ArchAI for SketchUp: the ArchAI toolbar and Extensions > ArchAI menu, and what they do.
require 'sketchup.rb'
require_relative 'core'
require_relative 'live'

module ArchAI
  ICONS = File.join(__dir__, 'icons')
  MM_PER_INCH = 25.4

  # ---- the model as ArchAI objects ----------------------------------------------------------------

  def self.visible?(entity)
    return false if entity.respond_to?(:hidden?) && entity.hidden?
    return false if entity.respond_to?(:layer) && entity.layer && !entity.layer.visible?
    true
  end

  def self.material_of(material, cache)
    return Core::DEFAULT_MATERIAL if material.nil?
    cache[material.name] ||= begin
      c = material.color
      Core::Material.new(material.display_name, c.red / 255.0, c.green / 255.0, c.blue / 255.0, material.use_alpha? ? material.alpha : 1.0)
    end
  end

  # Faces of an entity collection (recursing into groups and components) into one scene object.
  def self.collect_entities(entities, transform, inherited, item, cache, depth = 0)
    return if depth > 32
    entities.each do |entity|
      next unless visible?(entity)
      case entity
      when Sketchup::Face
        mesh = entity.mesh(0)
        mesh.transform!(transform)
        material = material_of(entity.material || entity.back_material || inherited, cache)
        positions = []
        mesh.points.each { |p| positions.concat(Core.from_z_up(p.x.to_f, p.y.to_f, p.z.to_f, MM_PER_INCH)) }
        indices = []
        mesh.polygons.each do |polygon|
          ids = polygon.map { |i| i.abs - 1 }
          (1...(ids.length - 1)).each { |k| indices.push(ids[0], ids[k], ids[k + 1]) }
        end
        item.add_mesh(material, positions, indices)
      when Sketchup::Group
        collect_entities(entity.entities, transform * entity.transformation, entity.material || inherited, item, cache, depth + 1)
      when Sketchup::ComponentInstance
        collect_entities(entity.definition.entities, transform * entity.transformation, entity.material || inherited, item, cache, depth + 1)
      end
    end
  end

  # What the Live Bridge brought in from ArchAI (never sent back).
  def self.live?(entity)
    entity.respond_to?(:get_attribute) && entity.get_attribute('ArchAI', 'live') == true
  end

  # Top-level groups and components are one object each; loose faces are one more.
  def self.collect(model, skip_live = false, progress = nil)
    cache = {}
    objects = []
    loose = Core::SceneObject.new('loose', 'Loose geometry', 'Model')
    entities = model.entities.to_a
    entities.each_with_index do |entity, index|
      Core.step(progress, index, entities.length, "Reading #{index + 1} of #{entities.length}")
      next unless visible?(entity)
      next if skip_live && live?(entity)
      case entity
      when Sketchup::Group, Sketchup::ComponentInstance
        name = entity.name.to_s
        name = entity.definition.name.to_s if name.empty?
        item = Core::SceneObject.new(entity.persistent_id.to_s, name.empty? ? 'Group' : name, entity.layer ? entity.layer.name : '')
        # Live Bridge: an editable copy of an ArchAI element.
        item.archai = entity.get_attribute('ArchAI', 'copy')
        definition_entities = entity.is_a?(Sketchup::Group) ? entity.entities : entity.definition.entities
        collect_entities(definition_entities, entity.transformation, entity.material, item, cache)
        objects << item if item.triangle_count > 0
      when Sketchup::Face
        collect_entities([entity], Geom::Transformation.new, nil, loose, cache)
      end
    end
    objects << loose if loose.triangle_count > 0
    objects
  end

  def self.cameras(model)
    model.pages.map do |page|
      camera = page.camera
      next nil unless camera && camera.perspective?
      eye = camera.eye
      d = camera.direction
      Core.camera_stop(page.name, Core.from_z_up(eye.x.to_f, eye.y.to_f, eye.z.to_f, MM_PER_INCH), Core.from_z_up(d.x, d.y, d.z, 1))
    end.compact
  end

  def self.document_name(model)
    model.path.empty? ? (model.title.empty? ? 'SketchUp model' : model.title) : File.basename(model.path, '.*')
  end

  # ---- actions -----------------------------------------------------------------------------------

  def self.send_to_archai
    model = Sketchup.active_model
    path = UI.savepanel('Send to ArchAI', File.dirname(model.path.empty? ? Dir.home : model.path), "#{document_name(model)}.AIR")
    return unless path
    path += '.AIR' unless path.downcase.end_with?('.air')
    progress = Core::Progress.new('Send to ArchAI')
    begin
      objects = collect(model, false, Core.scaled(progress.method(:update), 0.0, 0.9))
      progress.update('Writing the .AIR file', 0.95)
      exchange = Core.write_exchange(document_name(model), 'SketchUp', Sketchup.version, model.path, objects)
    ensure
      progress.finish
    end
    if exchange['meshes'].empty?
      show_result('Send to ArchAI', 'There are no visible faces, groups or components to send.')
      return
    end
    File.write(path, JSON.generate(exchange))
    count = exchange['meshes'].length
    show_result('Sent to ArchAI', "#{count} object#{count == 1 ? '' : 's'} saved to #{File.basename(path)}.\n\nOpen it in ArchAI (Open file) to work on it: each object comes in as a 3D element with its materials.")
  rescue StandardError => e
    show_result('Send to ArchAI', e.message)
  end

  def self.open_air
    path = UI.openpanel('Open .AIR in SketchUp', Dir.home, 'ArchAI document|*.AIR;*.air||')
    return unless path
    model = Sketchup.active_model
    progress = Core::Progress.new('Open .AIR')
    begin
      progress.update("Reading #{File.basename(path)}")
      name, objects = Core.read_air(path)
      count = import_objects(model, name, objects, false, Core.scaled(progress.method(:update), 0.1, 1.0))
    ensure
      progress.finish
    end
    Sketchup.active_model.active_view.zoom_extents
    show_result('Opened .AIR', "#{name}: #{count} element#{count == 1 ? '' : 's'} added in the group \"ArchAI #{name}\", a tag per level.\n\nUndo removes the import.")
  rescue StandardError => e
    show_result('Open .AIR', e.message)
  end

  # Removes the ArchAI Live group the Live Bridge brought in.
  def self.clear_live(model)
    live = model.entities.to_a.select { |entity| live?(entity) }
    return if live.empty?
    model.start_operation('ArchAI Live Bridge', true, false, true)
    model.entities.erase_entities(live)
    model.commit_operation
  end

  # Adds imported objects: a group per element inside one group, a tag per level. Returns the count.
  def self.import_objects(model, name, objects, live = false, progress = nil)
    model.start_operation(live ? 'ArchAI Live Bridge' : 'Open .AIR', true, false, live)
    materials = {}
    count = 0
    total = objects.length
    root = model.entities.add_group
    root.name = live ? 'ArchAI Live' : "ArchAI #{name}"
    root.set_attribute('ArchAI', 'live', true) if live
    Core.by_level(objects).each do |level, items|
      tag = model.layers.add("#{live ? 'ArchAI Live' : 'ArchAI'} #{level.empty? ? name : level}")
      items.each do |item|
        Core.step(progress, count, total, "Adding element #{count + 1} of #{total}")
        group = root.entities.add_group
        group.name = item.name
        group.layer = tag
        item.parts.each do |part|
          mesh = Geom::PolygonMesh.new(part.positions.length / 3, part.indices.length / 3)
          part.positions.each_slice(3) do |x, y, z|
            hx, hy, hz = Core.to_z_up(x, y, z, MM_PER_INCH)
            mesh.add_point(Geom::Point3d.new(hx, hy, hz))
          end
          part.indices.each_slice(3) { |a, b, c| mesh.add_polygon(a + 1, b + 1, c + 1) }
          material = (materials[part.material.name] ||= begin
            m = model.materials[part.material.name] || model.materials.add(part.material.name)
            m.color = Sketchup::Color.new((part.material.r * 255).round, (part.material.g * 255).round, (part.material.b * 255).round)
            m.alpha = part.material.opacity if part.material.opacity < 0.999
            m
          end)
          group.entities.add_faces_from_mesh(mesh, Geom::PolygonMesh::AUTO_SOFTEN | Geom::PolygonMesh::SMOOTH_SOFT_EDGES, material)
        end
        group.set_attribute('ArchAI', 'type', item.type) unless item.type.empty?
        count += 1
      end
    end
    model.commit_operation
    count
  rescue StandardError
    model.abort_operation
    raise
  end

  # ---- Live Bridge -------------------------------------------------------------------------------

  # Every top-level group and component that could be sent (hidden ones too), not what ArchAI sent.
  def self.all_ids(model)
    ids = model.entities.to_a.select { |e| (e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)) && !live?(e) }.map { |e| e.persistent_id.to_s }
    ids << 'loose'
  end

  def self.add_item_faces(model, entities, item, materials, transform = nil)
    item.parts.each do |part|
      mesh = Geom::PolygonMesh.new(part.positions.length / 3, part.indices.length / 3)
      part.positions.each_slice(3) do |x, y, z|
        hx, hy, hz = Core.to_z_up(x, y, z, MM_PER_INCH)
        point = Geom::Point3d.new(hx, hy, hz)
        point = point.transform(transform) if transform
        mesh.add_point(point)
      end
      part.indices.each_slice(3) { |a, b, c| mesh.add_polygon(a + 1, b + 1, c + 1) }
      material = (materials[part.material.name] ||= begin
        m = model.materials[part.material.name] || model.materials.add(part.material.name)
        m.color = Sketchup::Color.new((part.material.r * 255).round, (part.material.g * 255).round, (part.material.b * 255).round)
        m.alpha = part.material.opacity if part.material.opacity < 0.999
        m
      end)
      entities.add_faces_from_mesh(mesh, Geom::PolygonMesh::AUTO_SOFTEN | Geom::PolygonMesh::SMOOTH_SOFT_EDGES, material)
    end
  end

  # A Live Bridge pull, element by element: ArchAI's elements as groups in the "ArchAI Live" group
  # (attribute id; replaced or removed one by one), editable copies as top-level groups (attribute
  # copy; refilled in place, so they keep their id), and ArchAI's moves and names applied to the
  # model's own groups and components.
  def self.apply_delta(model, delta)
    model.start_operation('ArchAI Live Bridge', true, false, true)
    clear_live_now(model) if delta[:fresh]
    root = model.entities.to_a.find { |e| live?(e) && e.is_a?(Sketchup::Group) }
    live = {}
    copies = {}
    if root
      root.entities.to_a.each do |g|
        id = g.respond_to?(:get_attribute) ? g.get_attribute('ArchAI', 'id') : nil
        (live[id] ||= []) << g if id
      end
    end
    model.entities.to_a.each do |e|
      copy = e.respond_to?(:get_attribute) ? e.get_attribute('ArchAI', 'copy') : nil
      copies[copy] = e if copy
    end
    remove = lambda do |archai_id|
      groups = (live.delete(archai_id) || []).select(&:valid?)
      root.entities.erase_entities(groups) if root && !groups.empty?
    end
    delta[:removed].each { |archai_id| remove.call(archai_id) }
    delta[:updates].each do |update|
      entity = model.find_entity_by_persistent_id(update['ref'].to_i) rescue nil
      next unless entity && entity.valid?
      if update['move']
        x, y, z = Core.move_to_z_up(update['move'], MM_PER_INCH)
        entity.transform!(Geom::Transformation.translation(Geom::Vector3d.new(x, y, z)))
      end
      entity.name = update['name'] if update['name'] && entity.respond_to?(:name=)
    end
    materials = {}
    delta[:nodes].each do |item|
      archai_id = item.archai['id'].to_s
      target = item.archai['ref'] ? (model.find_entity_by_persistent_id(item.archai['ref'].to_i) rescue nil) : nil
      target ||= copies[archai_id]
      if target && target.valid? && target.is_a?(Sketchup::Group)
        # The model's copy of an ArchAI element: its shape follows ArchAI's, where the user put it.
        target.entities.clear!
        add_item_faces(model, target.entities, item, materials, target.transformation.inverse)
        next
      end
      remove.call(archai_id)
      if item.archai['editable']
        group = model.entities.add_group
        group.name = item.name
        group.set_attribute('ArchAI', 'copy', archai_id)
        add_item_faces(model, group.entities, item, materials)
        next
      end
      unless root && root.valid?
        root = model.entities.add_group
        root.name = 'ArchAI Live'
        root.set_attribute('ArchAI', 'live', true)
      end
      group = root.entities.add_group
      group.name = item.name
      group.set_attribute('ArchAI', 'id', archai_id)
      add_item_faces(model, group.entities, item, materials)
    end
    model.commit_operation
  rescue StandardError
    model.abort_operation
    raise
  end

  # Each received ArchAI element's group (transformation, entity count): edits to them are noticed
  # and reset.
  def self.live_fingerprints(model)
    root = model.entities.to_a.find { |e| live?(e) && e.is_a?(Sketchup::Group) }
    prints = {}
    return prints unless root && root.valid?
    root.entities.to_a.each do |g|
      id = g.respond_to?(:get_attribute) ? g.get_attribute('ArchAI', 'id') : nil
      next unless id
      (prints[id] ||= []) << [g.transformation.to_a.map { |v| v.round(6) }, g.respond_to?(:entities) ? g.entities.length : 0]
    end
    prints.transform_values(&:sort)
  end

  # Removes the ArchAI Live group inside an operation already started.
  def self.clear_live_now(model)
    live = model.entities.to_a.select { |entity| live?(entity) }
    model.entities.erase_entities(live) unless live.empty?
  end

  @upload = nil

  def self.open_vr
    if @upload
      show_result('Open in VR', 'ArchAI is still uploading the previous VR tour.')
      return
    end
    config = Core.share_config('SketchUp')
    unless config
      show_result('Open in VR', Core.no_key)
      return
    end
    model = Sketchup.active_model
    name = document_name(model)
    start = model.pages.selected_page ? model.pages.selected_page.name : nil
    progress = Core::Progress.new('Open in VR')
    objects = collect(model, false, Core.scaled(progress.method(:update), 0.0, 0.9))
    progress.update('Building the VR model')
    glb, tour, triangles, stops = Core.build_tour(name, 'SketchUp', objects, cameras(model), start)
    progress.finish
    unless glb
      show_result('Open in VR', 'There are no visible faces, groups or components to show.')
      return
    end
    if glb.bytesize > Core::MAX_MODEL_BYTES
      show_result('Open in VR', "The model is #{glb.bytesize / 1_048_576} MB; the VR share service takes up to 95 MB. Hide what you do not need to see and try again.")
      return
    end
    key = "sketchup|#{model.path.empty? ? "unsaved:#{name}" : model.path}"
    Sketchup.status_text = "ArchAI: uploading #{[1, glb.bytesize / 1_048_576].max} MB to the VR viewer..."
    @upload = true
    upload(config, Core.links[key], glb, tour) do |link, error|
      @upload = nil
      Sketchup.status_text = ''
      if error
        show_result('Open in VR', error)
      else
        Core.remember(key, link.split('/').last)
        UI.openURL(link)
        show_result('Opened in VR', Core.vr_message(name, triangles, stops, link), link)
      end
    end
  end

  # The share service calls, asynchronously (SketchUp keeps responding): reserve, model, tour.
  def self.upload(config, previous_id, glb, tour, &done)
    url, token = config
    request = lambda do |method, path, body, type, &next_step|
      http = Sketchup::Http::Request.new(url + path, method)
      http.headers = { 'Authorization' => "Bearer #{token}", 'Content-Type' => type }
      http.body = body
      http.start do |_req, response|
        if response.status_code >= 200 && response.status_code < 300
          next_step.call(response.body)
        else
          done.call(nil, "VR share service: #{response.status_code} #{response.body}")
        end
      end
      @requests = (@requests || []) << http # keep a reference until it completes
    end
    reserve = JSON.generate(previous_id ? { 'id' => previous_id } : {})
    request.call(Sketchup::Http::POST, '/tours', reserve, 'application/json') do |body|
      id = JSON.parse(body)['id'].to_s
      if id !~ /\A[a-z0-9]{4,16}\z/
        done.call(nil, 'VR share service returned an invalid tour id')
      else
        # The model first: the tour file is what makes the link show the new version.
        request.call(Sketchup::Http::PUT, "/tours/#{id}/model.glb", glb, 'model/gltf-binary') do
          request.call(Sketchup::Http::PUT, "/tours/#{id}/tour.json", JSON.generate(tour), 'application/json') do
            @requests = []
            done.call("#{url}/v/#{id}", nil)
          end
        end
      end
    end
  end

  # ---- interface ---------------------------------------------------------------------------------

  def self.escape(text)
    text.to_s.gsub('&', '&amp;').gsub('<', '&lt;').gsub('>', '&gt;').gsub('"', '&quot;')
  end

  # The end of an action: the message, an optional link to copy or open, and Done.
  def self.show_result(title, message, link = nil)
    logo = "data:image/png;base64,#{Base64.strict_encode64(File.binread(File.join(ICONS, 'logo-64.png')))}"
    link_html = link ? %(<input id="link" readonly value="#{escape(link)}"><div class="buttons"><button onclick="copy()">Copy link</button><button onclick="sketchup.open()">Open in browser</button><button class="primary" onclick="sketchup.close()">Done</button></div>) : %(<div class="buttons"><button class="primary" onclick="sketchup.close()">Done</button></div>)
    html = <<~HTML
      <!doctype html><html><head><meta charset="utf-8"><style>
        body { font: 13px "Segoe UI", -apple-system, sans-serif; color: #1f2126; margin: 0; padding: 18px 22px; background: #fff; }
        header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        header img { width: 26px; height: 26px; } h1 { font-size: 15px; margin: 0; }
        p { white-space: pre-wrap; line-height: 1.45; margin: 0 0 14px; }
        input { width: 100%; box-sizing: border-box; font: 15px Consolas, monospace; padding: 7px 9px; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 14px; }
        .buttons { display: flex; justify-content: flex-end; gap: 8px; }
        button { font: inherit; padding: 7px 16px; border-radius: 7px; border: 1px solid #e4e4e7; background: #fff; cursor: pointer; }
        button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; font-weight: 600; }
      </style></head><body>
        <header><img src="#{logo}"><h1>#{escape(title)}</h1></header>
        <p>#{escape(message)}</p>#{link_html}
        <script>function copy(){var i=document.getElementById('link');i.select();document.execCommand('copy');event.target.textContent='Copied';}</script>
      </body></html>
    HTML
    dialog = UI::HtmlDialog.new(dialog_title: title, preferences_key: 'ArchAI.result', width: 500, height: link ? 380 : 260, style: UI::HtmlDialog::STYLE_DIALOG)
    dialog.set_html(html)
    dialog.add_action_callback('close') { dialog.close }
    dialog.add_action_callback('open') { UI.openURL(link) if link }
    dialog.center
    dialog.show
  end

  # Live Bridge on / off (checked while it runs).
  def self.live_command
    c = command('Live Bridge', 'Sync this model with the project open in the ArchAI desktop app as you work: your model goes to ArchAI, ArchAI\'s model comes back in the ArchAI Live group. Click again to stop.', 'sync') { Live.toggle }
    c.set_validation_proc { Live.running? ? MF_CHECKED : MF_UNCHECKED }
    c
  end

  def self.command(title, tip, icon, &block)
    command = UI::Command.new(title, &block)
    command.tooltip = title
    command.status_bar_text = tip
    command.small_icon = File.join(ICONS, "#{icon}-16.png")
    command.large_icon = File.join(ICONS, "#{icon}-24.png")
    command
  end

  unless file_loaded?(__FILE__)
    commands = [
      command('Send to ArchAI', 'Save the visible model as an .AIR file to open in ArchAI.', 'export') { send_to_archai },
      command('Open .AIR', 'Bring an ArchAI .AIR file into this model, a tag per level.', 'import') { open_air },
      live_command,
      command('Link to project...', 'Choose the ArchAI project this model syncs with: ArchAI shows its projects.', 'sync') { Live.choose_project },
      command('Open in VR', 'Walk through the model in a VR headset (Meta Quest Browser) or any browser. Scenes become stops.', 'vr') { open_vr },
      command('ArchAI on the Web', 'Open the ArchAI web app.', 'web') { UI.openURL(Core::WEB_URL) }
    ]
    menu = UI.menu('Extensions').add_submenu('ArchAI')
    toolbar = UI::Toolbar.new('ArchAI')
    commands.each_with_index do |c, i|
      menu.add_separator if i == 5
      menu.add_item(c)
      toolbar.add_separator if i == 5
      toolbar.add_item(c)
    end
    toolbar.restore
    file_loaded(__FILE__)
  end
end
