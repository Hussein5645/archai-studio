# Run by the Python Editor Script Plugin when the editor starts: adds the ArchAI menu.
try:
    import archai_unreal.menus
    archai_unreal.menus.register()
except Exception as error:  # noqa: BLE001 - never break editor startup
    import unreal
    unreal.log_warning("ArchAI: the menu could not be added: %s" % error)
