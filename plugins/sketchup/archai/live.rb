# ArchAI for SketchUp: the Live Bridge with the ArchAI desktop app (electron/liveLink.ts in ArchAI;
# the Ruby twin of Archai.Plugins.LiveLink). While it is on, the model goes to the open ArchAI
# project a moment after each edit, and ArchAI's model comes back in the "ArchAI Live" group,
# replaced on every update and never sent back.
#
# SketchUp's Ruby runs on the UI thread: a timer polls ArchAI on the loopback interface with short
# requests (Net::HTTP); exports and imports run there too.
require 'json'
require 'net/http'
require 'securerandom'
require 'uri'
require 'digest'

module ArchAI
  module Live
    PORT = (ENV['ARCHAI_LIVE_PORT'].to_s =~ /\A\d+\z/ ? ENV['ARCHAI_LIVE_PORT'].to_i : 47821)
    DEBOUNCE = 1.5
    POLL = 2.0

    @link = nil

    def self.running?
      !@link.nil?
    end

    def self.toggle
      running? ? stop : start(Sketchup.active_model)
    end

    def self.key_of(model)
      "sketchup:#{model.path.empty? ? "unsaved:#{ArchAI.document_name(model)}" : model.path}"[0, 300]
    end

    # Link to project...: ArchAI shows its projects; this model syncs with the one picked there.
    # SketchUp waits while the choice is made in ArchAI.
    def self.choose_project
      model = Sketchup.active_model
      key = running? ? @link[:key] : key_of(model)
      body = JSON.generate('key' => key, 'app' => 'SketchUp', 'name' => ArchAI.document_name(model), 'choose' => true)
      result = request(Net::HTTP::Post, '/live/bind', body, 900)
      raise error_of(result) unless result.is_a?(Net::HTTPSuccess)
      reply = JSON.parse(result.body)
      if reply['cancelled']
        Sketchup.status_text = 'ArchAI Link to project: cancelled'
        return false
      end
      document = reply['document'] || {}
      project = { 'id' => document['id'].to_s, 'name' => document['name'].to_s }
      entry = Core.bridge_entry(key)
      same = entry['project'].is_a?(Hash) && entry['project']['id'] == project['id']
      known = reply['known'] || (same ? (entry['known'] || []).map(&:to_s) : [])
      Core.remember_bridge(key, { 'project' => project, 'known' => known })
      if running?
        @link[:project] = project
        @link[:known] = known
        @link[:have] = {}
        @link[:last_pulled] = @link[:last_seen] = -1
        @link[:pending_push] = nil
        @link[:sent_meshes] = {}
        @link[:tokens] = {}
        @link[:resend] = []
        @link[:received] = {}
        @link[:sync_request] = -1
        @link[:push_at] = 0.0
      end
      UI.messagebox("This model is linked to the ArchAI project #{project['name']}. The Live Bridge syncs with it from now on.")
      true
    rescue StandardError => e
      UI.messagebox("Link to project: #{e.message}\n\nIs the ArchAI desktop app running?")
    end

    def self.start(model)
      stop if running?
      key = key_of(model)
      @link = { model: model, key: key, name: ArchAI.document_name(model), push_at: Time.now.to_f, last_pulled: -1, last_seen: -1, quiet_until: 0.0, status: '' }
      # Live Bridge (protocol 2): the project this model is bound to, the ids ArchAI has from it,
      # what ArchAI sent (element id -> hash) and the update tokens applied.
      entry = Core.bridge_entry(@link[:key])
      @link[:project] = entry['project'].is_a?(Hash) ? entry['project'] : nil
      @link[:known] = (entry['known'] || []).map(&:to_s)
      @link[:have] = {}
      @link[:sent_meshes] = {}
      @link[:sync_request] = 0
      @link[:pending_push] = nil
      @link[:tokens] = {}
      # ArchAI elements reset here (another app's geometry edited in SketchUp): asked again.
      @link[:resend] = []
      @link[:received] = {}
      @observer = Observer.new
      model.add_observer(@observer)
      @timer = UI.start_timer(0.5, true) { tick }
      status('Connecting to ArchAI...')
    end

    def self.stop
      return unless running?
      UI.stop_timer(@timer) if @timer
      @link[:model].remove_observer(@observer) rescue nil
      begin
        request(Net::HTTP::Post, '/live/stop', JSON.generate('key' => @link[:key]), 3)
      rescue StandardError
        nil
      end
      @link = nil
      status('Off')
    end

    # The model changed: send it after a short pause (edits during an import are sent once it settled).
    def self.changed
      return unless running?
      now = Time.now.to_f
      unless now < @link[:quiet_until]
        # Another app's geometry edited here: ArchAI's version is put back.
        received = ArchAI.live_fingerprints(@link[:model])
        touched = (@link[:received].keys | received.keys).reject { |id| @link[:received][id] == received[id] }
        unless touched.empty?
          @link[:resend] = (@link[:resend] | touched)
          @link[:received] = received
          @link[:next_poll] = now
        end
      end
      @link[:push_at] = now < @link[:quiet_until] ? @link[:quiet_until] + DEBOUNCE : now + DEBOUNCE
    end

    def self.save_bridge
      Core.remember_bridge(@link[:key], @link[:project] ? { 'project' => @link[:project], 'known' => @link[:known] } : nil)
    end

    # Links this model to an ArchAI project (an existing one, or a new one when project_id is nil).
    def self.bind(project_id, new_name = nil)
      body = { 'key' => @link[:key], 'app' => 'SketchUp', 'name' => @link[:name] }
      if project_id then body['project'] = project_id else body['newName'] = new_name || @link[:name] end
      result = request(Net::HTTP::Post, '/live/bind', JSON.generate(body), 60)
      raise error_of(result) unless result.is_a?(Net::HTTPSuccess)
      document = JSON.parse(result.body)['document'] || {}
      @link[:known] = [] if @link[:project] && @link[:project]['id'] != document['id']
      @link[:project] = { 'id' => document['id'].to_s, 'name' => document['name'].to_s }
      @link[:pending_push] = nil
      @link[:sent_meshes] = {}
      @link[:have] = {}
      @link[:last_pulled] = -1
      save_bridge
      document
    end

    def self.status(text)
      @link[:status] = text if @link
      Sketchup.status_text = "ArchAI Live Bridge: #{text}"
    end

    def self.request(klass, path, body = nil, timeout = 180)
      uri = URI("http://127.0.0.1:#{PORT}#{path}")
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 2
      http.read_timeout = timeout
      req = klass.new(uri)
      req['X-ArchAI-Live'] = '1'
      req['Content-Type'] = 'application/json'
      req.body = body if body
      http.request(req)
    end

    # Starts the ArchAI desktop app through its archai:// link (registered by its installer), at
    # most once a minute.
    def self.launch(query)
      now = Time.now.to_f
      return @launched if @launched_at && now - @launched_at < 60
      @launched_at = now
      exe = installed_archai
      @launched =
        if exe
          system('cmd', '/c', 'start', '', exe) ? true : false
        elsif protocol_registered?
          UI.openURL("archai://live?#{query}") ? true : false
        else
          false
        end
    rescue StandardError
      @launched = false
    end

    # ArchAI.exe in its usual install folders (ARCHAI_EXE overrides), or nil.
    def self.installed_archai
      candidates = [ENV['ARCHAI_EXE'].to_s]
      candidates << File.join(ENV['LOCALAPPDATA'].to_s, 'Programs', 'ArchAI', 'ArchAI.exe') if ENV['LOCALAPPDATA']
      candidates << File.join(ENV['ProgramFiles'] || 'C:/Program Files', 'ArchAI', 'ArchAI.exe')
      candidates.find { |path| !path.empty? && File.file?(path) }
    end

    # Whether Windows knows the archai:// link (ArchAI installed somewhere else).
    def self.protocol_registered?
      require 'win32/registry'
      Win32::Registry::HKEY_CLASSES_ROOT.open('archai') { true }
    rescue StandardError, LoadError
      false
    end

    def self.error_of(response)
      JSON.parse(response.body)['error'] || response.body
    rescue StandardError
      response.body.to_s
    end

    def self.tick
      return unless running? && !@busy
      @busy = true
      now = Time.now.to_f
      if @link[:next_poll] && now < @link[:next_poll] && !(@link[:push_at] && now >= @link[:push_at])
        return
      end
      @link[:next_poll] = now + POLL
      query = URI.encode_www_form('key' => @link[:key], 'name' => @link[:name], 'app' => 'SketchUp', 'protocol' => 2, 'project' => (@link[:project] || {})['id'].to_s)
      begin
        response = request(Net::HTTP::Get, "/live/status?#{query}", nil, 60)
      rescue StandardError
        status(launch(query) ? 'Starting ArchAI...' : 'Install and start the ArchAI desktop app to sync')
        return
      end
      info = JSON.parse(response.body) rescue {}
      if info['protocol'].to_i >= 2 && info['needsLink']
        status('Choose an ArchAI project before starting the Live Bridge')
        stop unless choose_project
        return
      end
      project = info['document'] && info['document']['name']
      unless project
        # ArchAI opens a project for this model on its own (the one linked before, or a new one).
        status('Opening a project in ArchAI...')
        return
      end
      bridge = info['protocol'].to_i >= 2
      if bridge
        if info['mismatch']
          status("ArchAI shows #{project}; this model is linked to #{(@link[:project] || {})['name'] || 'another project'}. Open it in ArchAI, or link this model to the open project.")
          return
        end
        if @link[:project].nil? || @link[:project]['id'] != info['document']['id']
          @link[:project] = info['document']
          @link[:known] = info['known'] || []
          @link[:pending_push] = nil
          @link[:sent_meshes] = {}
          @link[:have] = {}
          @link[:tokens] = {}
          @link[:resend] = []
          @link[:received] = {}
          @link[:last_pulled] = @link[:last_seen] = -1
          @link[:sync_request] = -1
          @link[:push_at] = 0.0
          save_bridge
        end
      end
      up_to_date = @link[:last_seen] == @link[:last_pulled] && @link[:last_pulled] >= 0
      mode = bridge ? (info['mode'] || 'two-way') : 'two-way'
      if %w[paused disconnected].include?(mode)
        status(mode == 'paused' ? 'Paused in ArchAI' : 'Disconnected in ArchAI')
        return
      end
      if mode == 'two-way' && info.fetch('syncRequest', 0) != @link[:sync_request]
        @link[:sync_request] = info.fetch('syncRequest', 0)
        @link[:sent_meshes] = {}
        @link[:push_at] = now
      end
      if mode == 'two-way' && (@link[:pending_push] || (@link[:push_at] && now >= @link[:push_at]))
        @link[:push_at] = nil unless @link[:pending_push]
        model = @link[:model]
        reading = ->(text, fraction = nil) { status(fraction ? "#{text} (#{(fraction * 100).round}%)" : text) }
        exchange = @link[:pending_push] ? @link[:pending_push][:payload]['model'] : Core.write_exchange(@link[:name], 'SketchUp', Sketchup.version, model.path, ArchAI.collect(model, true, reading))
        status('Sending the model to ArchAI...')
        exchange['app'] = 'SketchUp'
        payload = { 'key' => @link[:key], 'app' => 'SketchUp', 'name' => @link[:name], 'model' => exchange }
        sent_ids = (exchange['meshes'] || []).map { |m| m['id'].to_s }
        deleted = []
        if bridge
          # Hiding deletes nothing: only ids gone from the model are deletions.
          everything = ArchAI.all_ids(model)
          deleted = @link[:known] - everything - sent_ids
          payload.merge!('protocol' => 2, 'project' => @link[:project]['id'], 'changeId' => SecureRandom.hex(16), 'complete' => false, 'deleted' => deleted)
        end
        hashes = {}
        if @link[:pending_push]
          pending = @link[:pending_push]
          payload, hashes, sent_ids, deleted = pending.values_at(:payload, :hashes, :ids, :deleted)
        else
          if bridge
            context = JSON.generate([exchange['materials'] || [], exchange['levels'] || []])
            changed = (exchange['meshes'] || []).select do |mesh|
              hash = Digest::SHA256.hexdigest(context + JSON.generate(mesh))
              hashes[mesh['id']] = hash
              @link[:sent_meshes][mesh['id']] != hash
            end
            payload['model'] = exchange.merge('meshes' => changed)
          end
          @link[:pending_push] = { payload: payload, hashes: hashes, ids: sent_ids, deleted: deleted }
        end
        result = request(Net::HTTP::Post, '/live/push', JSON.generate(payload))
        raise error_of(result) unless result.is_a?(Net::HTTPSuccess)
        reply = JSON.parse(result.body)
        if reply['refused']
          status(reply['message'] || 'ArchAI did not take the model')
          return
        end
        if bridge
          raise 'ArchAI did not acknowledge this change; it remains pending' unless reply['ack'] == payload['changeId']
          @link[:sent_meshes].merge!(hashes)
          deleted.each { |id| @link[:sent_meshes].delete(id) }
          @link[:known] = ((@link[:known] - deleted) + sent_ids).uniq
          save_bridge
        end
        @link[:pending_push] = nil
        revision = reply['revision'].to_i
        # Up to date before this push, and nothing else changed in ArchAI meanwhile.
        @link[:last_pulled] = revision if up_to_date && (reply['before'].nil? || reply['before'].to_i == @link[:last_seen])
        @link[:last_seen] = revision
        status("Sent to #{project} #{Time.now.strftime('%H:%M:%S')}")
        return
      end
      revision = info['revision'].to_i
      @link[:last_seen] = revision
      reset_ids = bridge ? @link[:resend].first(500) : []
      return if revision == @link[:last_pulled] && reset_ids.empty?
      fresh = bridge && @link[:have].empty?
      path = "/live/pull?key=#{URI.encode_www_form_component(@link[:key])}"
      path += "&protocol=2&project=#{URI.encode_www_form_component(@link[:project]['id'])}#{fresh ? '&fresh=1' : ''}" if bridge
      path += "&resend=#{URI.encode_www_form_component(reset_ids.join(','))}" unless reset_ids.empty?
      result = request(Net::HTTP::Get, path)
      return if result.code == '204'
      raise error_of(result) unless result.is_a?(Net::HTTPSuccess)
      pulled = (result['X-ArchAI-Revision'] || revision).to_i
      name = URI.decode_www_form_component(result['X-ArchAI-Name'] || project)
      if bridge
        objects, extras = Core.read_bridge_glb(result.body)
        present = (extras['present'] || []).map(&:to_s)
        removed = @link[:have].keys - present
        @link[:resend] -= reset_ids
        # Reset objects ArchAI no longer has (or no longer shares): removed here.
        removed |= (reset_ids - present)
        updates = (extras['updates'] || []).reject { |u| @link[:tokens][u['token']] }
        model = @link[:model]
        unless objects.empty? && removed.empty? && updates.empty? && !fresh
          @link[:quiet_until] = Time.now.to_f + 60
          begin
            ArchAI.apply_delta(model, { name: name, nodes: objects, removed: removed, updates: updates, fresh: fresh })
          ensure
            @link[:quiet_until] = Time.now.to_f + 1.0 if @link
          end
          status("Updated from #{project} #{Time.now.strftime('%H:%M:%S')}")
        end
        @link[:received] = ArchAI.live_fingerprints(model)
        @link[:have] = {} if fresh
        removed.each { |id| @link[:have].delete(id) }
        objects.each { |o| @link[:have][o.archai['id'].to_s] = o.archai['hash'].to_s if o.archai['id'] }
        present.each { |id| @link[:have][id] ||= '' }
        updates.each { |u| @link[:tokens][u['token']] = true }
        @link[:last_pulled] = @link[:last_seen] = pulled
        # Tell ArchAI where its changes landed (and which groups are now copies) right away.
        @link[:push_at] = Time.now.to_f if !updates.empty? || objects.any? { |o| o.archai['editable'] }
        return
      end
      objects = Core.read_glb(result.body)
      model = @link[:model]
      @link[:quiet_until] = Time.now.to_f + 60
      begin
        ArchAI.clear_live(model)
        building = ->(text, fraction = nil) { status(fraction ? "#{text} (#{(fraction * 100).round}%)" : text) }
        ArchAI.import_objects(model, name, objects, true, building)
      ensure
        @link[:quiet_until] = Time.now.to_f + 1.0 if @link
      end
      @link[:last_pulled] = @link[:last_seen] = pulled
      status("Updated from #{project} #{Time.now.strftime('%H:%M:%S')}")
    rescue StandardError => e
      status("Live Bridge: #{e.message}")
    ensure
      @busy = false
    end

    # Edits, undo and redo of the linked model.
    class Observer < Sketchup::ModelObserver
      def onTransactionCommit(_model)
        Live.changed
      end

      def onTransactionUndo(_model)
        Live.changed
      end

      def onTransactionRedo(_model)
        Live.changed
      end
    end
  end
end
