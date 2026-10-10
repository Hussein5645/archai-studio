# ArchAI for SketchUp: send models to ArchAI, open .AIR files and walk through the model in VR.
# Loader of the extension; the code is in archai/. Packaged as ArchAI.rbz by build-plugins.ps1.
require 'sketchup.rb'
require 'extensions.rb'

module ArchAI
  unless file_loaded?(__FILE__)
    extension = SketchupExtension.new('ArchAI', 'archai/main')
    extension.description = 'Send models to ArchAI, open ArchAI .AIR files and walk through the model in VR (Meta Quest Browser or any browser).'
    extension.version = '0.5.2'
    extension.creator = 'ArchAI'
    extension.copyright = 'ArchAI'
    Sketchup.register_extension(extension, true)
    file_loaded(__FILE__)
  end
end
