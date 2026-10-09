# ArchAI for SketchUp: the live link with the ArchAI desktop app (electron/liveLink.ts in ArchAI;
# the Ruby twin of Archai.Plugins.LiveLink). While it is on, the model goes to the open ArchAI
# project a moment after each edit, and ArchAI's model comes back in the "ArchAI Live" group,
# replaced on every update and never sent back.
#
# SketchUp's Ruby runs on the UI thread: a timer polls ArchAI on the loopback interface with short
# requests (Net::HTTP); exports and imports run there too.
require 'json'
require 'net/http'
require 'uri'

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

    def self.start(model)
      stop if running?
      key = "sketchup:#{model.path.empty? ? "unsaved:#{ArchAI.document_name(model)}" : model.path}"
      @link = { model: model, key: key[0, 300], name: ArchAI.document_name(model), push_at: Time.now.to_f, last_pulled: -1, last_seen: -1, quiet_until: 0.0, status: '' }
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

    # The model changed (not by our own import): send it after a short pause.
    def self.changed
      return unless running?
      return if Time.now.to_f < @link[:quiet_until]
      @link[:push_at] = Time.now.to_f + DEBOUNCE
    end

    def self.status(text)
      @link[:status] = text if @link
      Sketchup.status_text = "ArchAI live link: #{text}"
    end

    def self.request(klass, path, body = nil, timeout = 120)
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
      query = URI.encode_www_form('key' => @link[:key], 'name' => @link[:name], 'app' => 'SketchUp')
      begin
        response = request(Net::HTTP::Get, "/live/status?#{query}", nil, 5)
      rescue StandardError
        status(launch(query) ? 'Starting ArchAI...' : 'Install and start the ArchAI desktop app to sync')
        return
      end
      info = JSON.parse(response.body) rescue {}
      project = info['document'] && info['document']['name']
      unless project
        # ArchAI opens a project for this model on its own (the one linked before, or a new one).
        status('Opening a project in ArchAI...')
        return
      end
      up_to_date = @link[:last_seen] == @link[:last_pulled] && @link[:last_pulled] >= 0
      if @link[:push_at] && now >= @link[:push_at]
        @link[:push_at] = nil
        model = @link[:model]
        exchange = Core.write_exchange(@link[:name], 'SketchUp', Sketchup.version, model.path, ArchAI.collect(model, true))
        exchange['app'] = 'SketchUp'
        body = JSON.generate('key' => @link[:key], 'app' => 'SketchUp', 'name' => @link[:name], 'model' => exchange)
        result = request(Net::HTTP::Post, '/live/push', body)
        raise error_of(result) unless result.is_a?(Net::HTTPSuccess)
        revision = JSON.parse(result.body)['revision'].to_i
        @link[:last_pulled] = revision if up_to_date
        @link[:last_seen] = revision
        status("Sent to #{project} #{Time.now.strftime('%H:%M:%S')}")
        return
      end
      revision = info['revision'].to_i
      @link[:last_seen] = revision
      return if revision == @link[:last_pulled]
      result = request(Net::HTTP::Get, "/live/pull?key=#{URI.encode_www_form_component(@link[:key])}")
      return if result.code == '204'
      raise error_of(result) unless result.is_a?(Net::HTTPSuccess)
      pulled = (result['X-ArchAI-Revision'] || revision).to_i
      name = URI.decode_www_form_component(result['X-ArchAI-Name'] || project)
      objects = Core.read_glb(result.body)
      model = @link[:model]
      @link[:quiet_until] = Time.now.to_f + 60
      begin
        ArchAI.clear_live(model)
        ArchAI.import_objects(model, name, objects, true)
      ensure
        @link[:quiet_until] = Time.now.to_f + 1.0 if @link
      end
      @link[:last_pulled] = @link[:last_seen] = pulled
      status("Updated from #{project} #{Time.now.strftime('%H:%M:%S')}")
    rescue StandardError => e
      status("Live link: #{e.message}")
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
