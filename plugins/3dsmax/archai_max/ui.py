"""The ArchAI panel of 3ds Max: a dockable window with the three actions and the ArchAI icon set."""
import os
import threading

from pymxs import runtime as rt

try:
    from PySide6 import QtCore, QtGui, QtWidgets
except ImportError:  # 3ds Max 2024 and earlier
    from PySide2 import QtCore, QtGui, QtWidgets

from . import archai_core as core
from . import scene

ICONS = os.path.join(os.path.dirname(__file__), "icons")
MUTED = "#6b707a"
_panel = None
_live = {"link": None, "timer": None, "signature": None}


class _Main(QtCore.QObject):
    """Runs functions from the Live Bridge's thread on 3ds Max's main thread."""
    call = QtCore.Signal(object)
    status = QtCore.Signal(str)

    def __init__(self):
        super().__init__()
        self.call.connect(lambda fn: fn(), QtCore.Qt.QueuedConnection)


_main = None


def live_running():
    return _live["link"] is not None


def toggle_live(status=None):
    """Live Bridge with the ArchAI desktop app: the scene goes to the open project after each edit, ArchAI's model comes back on the ArchAI Live layers."""
    global _main
    if _live["link"] is not None:
        _live["link"].stop()
        _live["link"] = None
        if _live["timer"] is not None:
            _live["timer"].stop()
        if status:
            status("Live Bridge: off")
        return False
    if _main is None:
        _main = _Main()
    if status:
        try:
            _main.status.disconnect()
        except (RuntimeError, TypeError):
            pass
        _main.status.connect(lambda text: status("Live Bridge: " + text), QtCore.Qt.QueuedConnection)

    def do_import(name, objects):
        scene.clear_live()
        scene.import_objects(name, objects, live=True)
        _live["signature"] = scene.signature()

    # Slow syncs (a first sync, a big scene) show 3ds Max's progress bar; quick ones do not.
    meter = scene.Progress("Live Bridge")
    gate = core.DelayedProgress(meter.begin, meter.update, meter.end, _main.call.emit)
    link = core.LiveLink(scene.document_key().replace("3dsmax|", "3dsmax:"), "3ds Max", scene.document_name(), scene.live_exchange, do_import, _main.call.emit, _main.status.emit,
                         progress=gate.report, finished=gate.finished)
    _live["link"] = link
    _live["signature"] = scene.signature()

    def poll():
        if _live["link"] is None or link.quiet():
            return
        current = scene.signature()
        if current != _live["signature"]:
            _live["signature"] = current
            link.changed()
    timer = QtCore.QTimer()
    timer.setInterval(1500)
    timer.timeout.connect(poll)
    timer.start()
    _live["timer"] = timer
    link.start()
    return True


def _icon(name, size=32):
    return QtGui.QIcon(os.path.join(ICONS, "%s-%d.png" % (name, size)))


def _main_window():
    try:
        import qtmax
        return qtmax.GetQMaxMainWindow()
    except Exception:  # noqa: BLE001
        return None


def message(title, text, link=None):
    """The end of an action: the message, an optional link to copy or open, and Done."""
    dialog = QtWidgets.QDialog(_main_window())
    dialog.setWindowTitle(title)
    dialog.setMinimumWidth(460)
    layout = QtWidgets.QVBoxLayout(dialog)
    header = QtWidgets.QHBoxLayout()
    logo = QtWidgets.QLabel()
    logo.setPixmap(_icon("logo", 32).pixmap(26, 26))
    heading = QtWidgets.QLabel("<b>%s</b>" % title)
    heading.setStyleSheet("font-size: 14px")
    header.addWidget(logo)
    header.addWidget(heading, 1)
    layout.addLayout(header)
    body = QtWidgets.QLabel(text)
    body.setWordWrap(True)
    layout.addWidget(body)
    buttons = QtWidgets.QHBoxLayout()
    buttons.addStretch(1)
    if link:
        field = QtWidgets.QLineEdit(link)
        field.setReadOnly(True)
        field.setStyleSheet("font-family: Consolas; font-size: 14px; padding: 4px")
        layout.addWidget(field)
        copy = QtWidgets.QPushButton("Copy link")
        copy.clicked.connect(lambda: (QtWidgets.QApplication.clipboard().setText(link), copy.setText("Copied")))
        open_button = QtWidgets.QPushButton("Open in browser")
        open_button.clicked.connect(lambda: core.open_in_browser(link))
        buttons.addWidget(copy)
        buttons.addWidget(open_button)
    done = QtWidgets.QPushButton("Done")
    done.setDefault(True)
    done.clicked.connect(dialog.accept)
    buttons.addWidget(done)
    layout.addLayout(buttons)
    dialog.exec()


def send():
    path, _ = QtWidgets.QFileDialog.getSaveFileName(_main_window(), "Send to ArchAI", scene.document_name() + ".AIR", "ArchAI document (*.AIR)")
    if not path:
        return
    meter = scene.Progress("Send to ArchAI")
    try:
        try:
            count = scene.send(path, meter.update)
        finally:
            meter.end()
        message("Sent to ArchAI", "%d object%s saved to %s.\n\nOpen it in ArchAI (Open file) to work on it: each object comes in as a 3D element with its materials." % (count, "" if count == 1 else "s", os.path.basename(path)))
    except Exception as error:  # noqa: BLE001
        message("Send to ArchAI", str(error))


def open_air():
    path, _ = QtWidgets.QFileDialog.getOpenFileName(_main_window(), "Open .AIR in 3ds Max", "", "ArchAI document (*.AIR)")
    if not path:
        return
    meter = scene.Progress("Open .AIR")
    try:
        try:
            name, count = scene.import_air(path, meter.update)
        finally:
            meter.end()
        message("Opened .AIR", "%s: %d element%s added, on an ArchAI layer per level.\n\nUndo removes the import." % (name, count, "" if count == 1 else "s"))
    except Exception as error:  # noqa: BLE001
        message("Open .AIR", str(error))


class _Upload(QtCore.QObject):
    """Uploads off the UI thread and reports back on it (progress included)."""
    finished = QtCore.Signal(object, object)
    progress = QtCore.Signal(str, object)

    def start(self, config, key, glb, tour):
        def work():
            try:
                upload = core.scaled(lambda text, fraction=None: self.progress.emit(text, fraction), 0.35, 1.0)
                self.finished.emit(core.publish(config, key, glb, tour, upload), None)
            except Exception as error:  # noqa: BLE001
                self.finished.emit(None, str(error))
        threading.Thread(target=work, daemon=True).start()


_upload = None


def open_vr(status=None):
    global _upload
    config = core.share_config("3ds Max")
    if config is None:
        message("Open in VR", core.NO_KEY)
        return
    meter = scene.Progress("Open in VR")
    meter.begin("Reading the scene")
    glb, tour, triangles, stops, name, key = scene.prepare_tour(core.scaled(meter.update, 0.0, 0.3))
    if not glb:
        meter.end()
        message("Open in VR", "There are no visible geometry objects to show.")
        return
    meter.update("Uploading %s" % core.megabytes(len(glb)), 0.35)
    if status:
        status("Uploading %d MB to the VR viewer..." % max(1, len(glb) // 1048576))

    def done(link, error):
        meter.end()
        if status:
            status("")
        if error:
            message("Open in VR", error)
            return
        core.open_in_browser(link)
        QtWidgets.QApplication.clipboard().setText(link)
        message("Opened in VR", core.vr_message(name, triangles, stops, link), link)

    _upload = _Upload()
    _upload.finished.connect(done, QtCore.Qt.QueuedConnection)
    _upload.progress.connect(meter.update, QtCore.Qt.QueuedConnection)
    _upload.start(config, key, glb, tour)


class Panel(QtWidgets.QDockWidget):
    def __init__(self, parent=None):
        super().__init__("ArchAI", parent)
        self.setObjectName("ArchAIPanel")
        self.setAllowedAreas(QtCore.Qt.LeftDockWidgetArea | QtCore.Qt.RightDockWidgetArea)
        body = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(body)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)
        header = QtWidgets.QHBoxLayout()
        logo = QtWidgets.QLabel()
        logo.setPixmap(_icon("logo", 48).pixmap(36, 36))
        titles = QtWidgets.QVBoxLayout()
        titles.addWidget(QtWidgets.QLabel("<b style='font-size:14px'>ArchAI</b>"))
        tagline = QtWidgets.QLabel("Design, share and walk through in VR")
        tagline.setStyleSheet("color: %s" % MUTED)
        titles.addWidget(tagline)
        header.addWidget(logo)
        header.addLayout(titles, 1)
        layout.addLayout(header)
        layout.addSpacing(6)
        self.status = QtWidgets.QLabel("")
        self.status.setWordWrap(True)
        self.status.setStyleSheet("color: %s" % MUTED)
        for icon, title, text, action in (
            ("export", "Send to ArchAI", "Save the visible scene as an .AIR file for ArchAI.", send),
            ("import", "Open .AIR", "Bring an ArchAI file in, a layer per level.", open_air),
            ("sync", "Live Bridge", "Sync with the project open in the ArchAI desktop app as you work: your scene goes to ArchAI, ArchAI's model comes back on the ArchAI Live layers. Click again to stop.", lambda: toggle_live(self.status.setText)),
            ("vr", "Open in VR", "Walk through the scene on a headset or in a browser. Cameras become stops.", lambda: open_vr(self.status.setText)),
            ("web", "ArchAI on the web", "Open the ArchAI web app.", lambda: core.open_in_browser(core.WEB_URL)),
        ):
            button = QtWidgets.QPushButton(" " + title)
            button.setIcon(_icon(icon, 32))
            button.setIconSize(QtCore.QSize(28, 28))
            button.setMinimumHeight(42)
            button.setStyleSheet("text-align: left; padding-left: 8px; font-weight: 600")
            button.setToolTip(text)
            button.clicked.connect(action)
            layout.addWidget(button)
            hint = QtWidgets.QLabel(text)
            hint.setWordWrap(True)
            hint.setStyleSheet("color: %s; font-size: 11px; margin-bottom: 4px" % MUTED)
            layout.addWidget(hint)
        layout.addWidget(self.status)
        layout.addStretch(1)
        self.setWidget(body)


def show_panel():
    global _panel
    main = _main_window()
    if _panel is None:
        _panel = Panel(main)
        if main is not None:
            main.addDockWidget(QtCore.Qt.RightDockWidgetArea, _panel)
        else:
            _panel.setFloating(True)
    _panel.show()
    _panel.raise_()
