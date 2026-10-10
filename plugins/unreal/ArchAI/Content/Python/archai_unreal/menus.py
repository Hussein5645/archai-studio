"""The ArchAI menu of the Unreal Editor (main menu bar, next to Help) and its actions."""
import os
import threading

import unreal

from . import archai_core as core
from . import scene

_job = {"thread": None, "result": None, "error": None, "tick": None, "info": None, "progress": None, "meter": None}
_live = {"link": None, "tick": None, "queue": [], "signature": None, "since": 0.0}


def _live_tick(delta):
    """Runs the Live Bridge's main-thread work and notices edits to the level."""
    queue, _live["queue"] = _live["queue"], []
    for fn in queue:
        fn()
    link = _live["link"]
    if link is None:
        return
    _live["since"] += delta
    if _live["since"] < 1.5 or link.quiet():
        return
    _live["since"] = 0.0
    current = scene.signature()
    if current != _live["signature"]:
        _live["signature"] = current
        link.changed()


def toggle_live():
    """Live Bridge with the ArchAI desktop app: the level goes to the open project after each edit, ArchAI's model comes back in the ArchAI Live outliner folder."""
    if _live["link"] is not None:
        _live["link"].stop()
        _live["link"] = None
        if _live["tick"] is not None:
            unreal.unregister_slate_post_tick_callback(_live["tick"])
            _live["tick"] = None
        unreal.log("ArchAI Live Bridge is off.")
        return

    def do_import(name, objects):
        scene.clear_live()
        scene.import_objects(name, objects, live=True)
        _live["signature"] = scene.signature()

    def status(text):
        unreal.log("ArchAI Live Bridge: " + text)

    # Slow syncs (a first sync, a big level) show Unreal's progress dialog; quick ones do not.
    meter = scene.Progress("Live Bridge")
    gate = core.DelayedProgress(meter.begin, meter.update, meter.end, _live["queue"].append)
    def do_apply(delta):
        scene.apply_delta(delta)
        _live["signature"] = scene.signature()

    link = core.LiveLink(scene.document_key().replace("unreal|", "unreal:"), "Unreal", scene.level_name(), scene.live_exchange, do_import, _live["queue"].append, status,
                         progress=gate.report, finished=gate.finished, apply=do_apply, all_ids=scene.all_ids)
    _live["link"] = link
    _live["signature"] = scene.signature()
    _live["tick"] = unreal.register_slate_post_tick_callback(_live_tick)
    link.start()
    unreal.log("ArchAI Live Bridge is on: the level goes to the project open in the ArchAI desktop app; its model comes back in the ArchAI Live folder.")


def link_project():
    """Link to project...: ArchAI shows its projects; the level syncs with the one picked there."""
    link = _live["link"] or core.LiveLink(scene.document_key().replace("unreal|", "unreal:"), "Unreal", scene.level_name(), lambda: None, lambda *a: None, _live["queue"].append)

    def work():
        try:
            document = link.choose_project()
            unreal.log("ArchAI: " + ("linked to %s" % document.get("name") if document else "Link to project cancelled"))
        except Exception as error:  # noqa: BLE001
            unreal.log_warning("ArchAI Link to project: %s (is the ArchAI desktop app running?)" % error)
    threading.Thread(target=work, name="ArchAI link project", daemon=True).start()
    unreal.log("ArchAI: choose the project in ArchAI.")


def _message(title, text):
    unreal.EditorDialog.show_message(title, text, unreal.AppMsgType.OK)


def _file_dialog(save, title, default_name=""):
    """A native Windows file dialog (the editor's Python has no file dialog of its own)."""
    if os.name != "nt":
        folder = os.path.join(unreal.Paths.project_saved_dir(), "ArchAI")
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, default_name or "import.AIR")
    import ctypes
    from ctypes import wintypes

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND), ("hInstance", wintypes.HINSTANCE),
                    ("lpstrFilter", wintypes.LPCWSTR), ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
                    ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR), ("nMaxFile", wintypes.DWORD),
                    ("lpstrFileTitle", wintypes.LPWSTR), ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
                    ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD), ("nFileOffset", wintypes.WORD),
                    ("nFileExtension", wintypes.WORD), ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
                    ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR), ("pvReserved", ctypes.c_void_p),
                    ("dwReserved", wintypes.DWORD), ("FlagsEx", wintypes.DWORD)]

    buffer = ctypes.create_unicode_buffer(default_name, 1024)
    dialog = OPENFILENAMEW()
    dialog.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    dialog.hwndOwner = ctypes.windll.user32.GetForegroundWindow()
    dialog.lpstrFilter = "ArchAI document (*.AIR)\0*.AIR\0\0"
    dialog.lpstrFile = ctypes.cast(buffer, wintypes.LPWSTR)
    dialog.nMaxFile = 1024
    dialog.lpstrTitle = title
    dialog.lpstrDefExt = "AIR"
    dialog.Flags = 0x00000002 | 0x00000800 if save else 0x00001000 | 0x00000800  # OVERWRITEPROMPT|PATHMUSTEXIST, FILEMUSTEXIST|PATHMUSTEXIST
    ok = ctypes.windll.comdlg32.GetSaveFileNameW(ctypes.byref(dialog)) if save else ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(dialog))
    return buffer.value if ok else None


def send():
    path = _file_dialog(True, "Send to ArchAI", scene.level_name() + ".AIR")
    if not path:
        return
    meter = scene.Progress("Send to ArchAI")
    try:
        try:
            count = scene.send(path, meter.update)
        finally:
            meter.end()
        _message("Sent to ArchAI", "%d actor%s saved to %s.\n\nOpen it in ArchAI (Open file) to work on it." % (count, "" if count == 1 else "s", os.path.basename(path)))
    except Exception as error:  # noqa: BLE001
        _message("Send to ArchAI", str(error))


def open_air():
    path = _file_dialog(False, "Open .AIR in Unreal")
    if not path:
        return
    try:
        name, count = scene.import_air(path)
        _message("Opened .AIR", "%s: %d static mesh actor%s placed in the level, in the ArchAI/%s outliner folder." % (name, count, "" if count == 1 else "s", name))
    except Exception as error:  # noqa: BLE001
        _message("Open .AIR", str(error))


def open_vr():
    if _job["thread"] is not None:
        _message("Open in VR", "ArchAI is still uploading the previous VR tour.")
        return
    config = core.share_config("Unreal")
    if config is None:
        _message("Open in VR", core.NO_KEY)
        return
    meter = scene.Progress("Open in VR")
    meter.begin("Reading the level")
    glb, tour, triangles, stops, name, key = scene.prepare_tour(core.scaled(meter.update, 0.0, 0.3))
    if not glb:
        meter.end()
        _message("Open in VR", "There are no visible static meshes in the level to show.")
        return
    meter.update("Uploading %s" % core.megabytes(len(glb)), 0.35)
    _job["meter"] = meter
    unreal.log("ArchAI: uploading %d MB to the VR viewer..." % max(1, len(glb) // 1048576))

    def work():
        try:
            upload = core.scaled(lambda text, fraction=None: _job.__setitem__("progress", (text, fraction)), 0.35, 1.0)
            _job["result"] = core.publish(config, key, glb, tour, upload)
        except Exception as error:  # noqa: BLE001
            _job["error"] = str(error)

    _job.update(result=None, error=None, info=(name, triangles, stops), thread=threading.Thread(target=work, daemon=True))
    _job["thread"].start()
    _job["tick"] = unreal.register_slate_post_tick_callback(_poll)


def _poll(_delta):
    meter = _job["meter"]
    if _job["thread"] is None or _job["thread"].is_alive():
        if meter is not None and _job["progress"] is not None:
            meter.update(*_job["progress"])
        return
    unreal.unregister_slate_post_tick_callback(_job["tick"])
    if meter is not None:
        meter.end()
    _job["meter"] = _job["progress"] = None
    _job["thread"] = None
    if _job["error"]:
        _message("Open in VR", _job["error"])
        return
    link = _job["result"]
    name, triangles, stops = _job["info"]
    core.open_in_browser(link)
    _clipboard(link)
    _message("Opened in VR", core.vr_message(name, triangles, stops, link) + "\n\n(The link is on your clipboard.)")


def _clipboard(text):
    if os.name != "nt":
        return
    try:
        import subprocess
        subprocess.run("clip", input=text.encode("utf-16-le"), check=False, creationflags=0x08000000)
    except Exception:  # noqa: BLE001
        pass


def register():
    menus = unreal.ToolMenus.get()
    main = menus.find_menu("LevelEditor.MainMenu")
    if main is None:
        return
    menu = main.add_sub_menu("ArchAI", "ArchAI", "ArchAI", "ArchAI", "Send to ArchAI, open .AIR files, open in VR")
    for name, label, tip, command, section in (
        ("ArchaiSend", "Send to ArchAI...", "Save the level's visible static meshes as an .AIR file for ArchAI.", "import archai_unreal.menus as m; m.send()", "Exchange"),
        ("ArchaiOpenAir", "Open .AIR...", "Bring an ArchAI .AIR file into the level.", "import archai_unreal.menus as m; m.open_air()", "Exchange"),
        ("ArchaiLive", "Live Bridge (on / off)", "Sync the level with the project open in the ArchAI desktop app as you work: your actors go to ArchAI, ArchAI's model comes back in the ArchAI Live outliner folder.", "import archai_unreal.menus as m; m.toggle_live()", "Live"),
        ("ArchaiLinkProject", "Link to project...", "Choose the ArchAI project this level syncs with: ArchAI shows its projects.", "import archai_unreal.menus as m; m.link_project()", "Live"),
        ("ArchaiVR", "Open in VR", "Walk through the level in a VR headset (Meta Quest Browser) or any browser. Camera actors become stops.", "import archai_unreal.menus as m; m.open_vr()", "VR"),
        ("ArchaiWeb", "ArchAI on the Web", "Open the ArchAI web app.", "import archai_unreal.archai_core as c; c.open_in_browser(c.WEB_URL)", "Web"),
    ):
        entry = unreal.ToolMenuEntry(name=name, type=unreal.MultiBlockType.MENU_ENTRY)
        entry.set_label(label)
        entry.set_tool_tip(tip)
        entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", command)
        menu.add_menu_entry(section, entry)
    menus.refresh_all_widgets()
