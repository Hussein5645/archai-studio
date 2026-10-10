-- ArchAI in 3ds Max (2025 and later): run at startup from the ArchAI.bundle application plugin.
-- Puts the archai_max Python package on the path, defines the ArchAI macroscripts and adds an
-- "ArchAI" menu to the main menu bar. The ArchAI panel (a dockable window) opens from that menu.
(
    local here = getFilenamePath (getThisScriptFilename())
    python.Execute ("import sys\nif r'" + here + "' not in sys.path: sys.path.insert(0, r'" + here + "')")
)

macroScript ArchaiPanel category:"ArchAI" buttonText:"ArchAI Panel" tooltip:"Open the ArchAI panel"
(
    python.Execute "from archai_max import ui; ui.show_panel()"
)
macroScript ArchaiSend category:"ArchAI" buttonText:"Send to ArchAI" tooltip:"Save the visible scene as an .AIR file for ArchAI"
(
    python.Execute "from archai_max import ui; ui.send()"
)
macroScript ArchaiOpenAir category:"ArchAI" buttonText:"Open .AIR" tooltip:"Bring an ArchAI .AIR file into the scene"
(
    python.Execute "from archai_max import ui; ui.open_air()"
)
macroScript ArchaiLive category:"ArchAI" buttonText:"Live Bridge" tooltip:"Sync the scene with the project open in the ArchAI desktop app (click again to stop)"
(
    python.Execute "from archai_max import ui; ui.show_panel(); ui.toggle_live(ui._panel.status.setText if ui._panel else None)"
)
macroScript ArchaiVR category:"ArchAI" buttonText:"Open in VR" tooltip:"Walk through the scene in a VR headset or any browser"
(
    python.Execute "from archai_max import ui; ui.open_vr()"
)
macroScript ArchaiWeb category:"ArchAI" buttonText:"ArchAI on the Web" tooltip:"Open the ArchAI web app"
(
    python.Execute "from archai_max import archai_core; archai_core.open_in_browser(archai_core.WEB_URL)"
)

-- The 3ds Max 2025 menu system: menus are (re)built through this callback.
fn archaiRegisterMenus =
(
    local bar = callbacks.notificationParam()
    local menu = bar.CreateSubMenu "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b02" "ArchAI"
    -- 647394 is the macroscript action table; action ids are "Macro`Category".
    menu.CreateAction "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b03" 647394 "ArchaiPanel`ArchAI"
    menu.CreateSeparator "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b04"
    menu.CreateAction "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b05" 647394 "ArchaiSend`ArchAI"
    menu.CreateAction "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b06" 647394 "ArchaiOpenAir`ArchAI"
    menu.CreateAction "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b0a" 647394 "ArchaiLive`ArchAI"
    menu.CreateAction "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b07" 647394 "ArchaiVR`ArchAI"
    menu.CreateSeparator "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b08"
    menu.CreateAction "6a3f2c1e-8b4d-4e7a-9f21-3c5d7e9a1b09" 647394 "ArchaiWeb`ArchAI"
)
callbacks.removeScripts id:#archaiMenus
callbacks.addScript #cuiRegisterMenus archaiRegisterMenus id:#archaiMenus
