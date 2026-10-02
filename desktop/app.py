"""GTK4/WebKitGTK lifecycle for the local ASIP application."""
from __future__ import annotations

import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from .backend import DesktopBackend
from .bridge import BridgeRequest, BridgeError, failure

APP_ID = "org.asip.Desktop"
ASSET_ROOT = Path(__file__).with_name("assets")

def _load_gi():
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("WebKit", "6.0")
    from gi.repository import Gio, GLib, Gtk, WebKit
    return Gio, GLib, Gtk, WebKit

def asset_uri():
    return (ASSET_ROOT / "index.html").resolve().as_uri()

class DesktopRuntime:
    def __init__(self, backend=None):
        self.Gio, self.GLib, self.Gtk, self.WebKit = _load_gi()
        self.backend = backend or DesktopBackend()
        self.backend.set_event_sink(self._event_received)
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="asip-desktop")
        self.pending = threading.BoundedSemaphore(32)
        self.application = self.Gtk.Application(application_id=APP_ID)
        self.Gtk.Window.set_default_icon_name(APP_ID)
        self.application.connect("activate", self._activate)
        self.window = self.webview = None
        self.closed = False

    def _activate(self, application):
        if self.window is not None:
            self.window.present()
            return
        manager = self.WebKit.UserContentManager()
        if not manager.register_script_message_handler("asip"):
            raise RuntimeError("could not register ASIP message handler")
        manager.connect("script-message-received::asip", self._message_received)
        self.webview = self.WebKit.WebView(user_content_manager=manager)
        self.webview.connect("web-process-terminated", self._web_process_terminated)
        self.webview.connect("decide-policy", self._decide_policy)
        self.webview.get_settings().set_enable_developer_extras(True)
        self.webview.load_uri(asset_uri())
        self.window = self.Gtk.ApplicationWindow(application=application)
        self.window.set_title("ASIP")
        self.window.set_icon_name(APP_ID)
        self.window.set_default_size(1220, 800)
        self.window.set_child(self.webview)
        self.window.present()

    def _decide_policy(self, _view, decision, kind):
        if kind not in (self.WebKit.PolicyDecisionType.NAVIGATION_ACTION,
                        self.WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        if kind == self.WebKit.PolicyDecisionType.NAVIGATION_ACTION and uri.split("#",1)[0] == asset_uri():
            return False
        decision.ignore()
        if urlparse(uri).scheme == "https":
            self._open_external(uri)
        return True

    def _message_received(self, _manager, value):
        if self.closed or (self.webview.get_uri() or '').split("#",1)[0] != asset_uri():
            return
        try:
            raw = value.to_json(0)
            request = BridgeRequest.parse(raw)
        except (AttributeError, BridgeError):
            return
        if not self.pending.acquire(blocking=False):
            self._deliver(failure(request.request_id,"busy","Too many pending actions; retry"))
            return
        future = self.executor.submit(self.backend.handle, raw)
        def completed(result):
            try:
                response = result.result()
            except Exception:
                response = failure(request.request_id,"backend_unavailable","Action interrupted; retry or inspect its state")
            finally:
                self.pending.release()
            self.GLib.idle_add(self._deliver, response)
        future.add_done_callback(completed)

    def _javascript(self, method, message):
        if not self.closed and self.webview is not None and (self.webview.get_uri() or '').split("#",1)[0] == asset_uri():
            script = "window.ASIPNative.%s(%s);" % (method,json.dumps(message))
            self.webview.evaluate_javascript(script,-1,None,asset_uri(),None,None,None)
        return False

    def _deliver(self, message):
        return self._javascript("receive",message)

    def _event_received(self, message):
        if message.get("method") == "desktop/openExternal":
            uri = message.get("payload",{}).get("url")
            if isinstance(uri,str) and urlparse(uri).scheme == "https":
                self.GLib.idle_add(self._open_external,uri)
        else:
            self.GLib.idle_add(self._javascript,"event",message)

    def _open_external(self, uri):
        if not self.closed:
            self.Gio.AppInfo.launch_default_for_uri(uri,None)
        return False

    def _web_process_terminated(self, _view, _reason):
        self.GLib.timeout_add(250,self._reload_after_crash)

    def _reload_after_crash(self):
        if not self.closed:
            self.webview.load_uri(asset_uri())
        return False

    def run(self, argv):
        try:
            return self.application.run(argv)
        finally:
            self.closed = True
            self.backend.close()
            self.executor.shutdown(wait=False,cancel_futures=True)

def main(argv=None):
    return DesktopRuntime().run(argv or [sys.argv[0]])
