import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class ASIPBeacon extends Extension {
    enable() {
        this._button = new PanelMenu.Button(0.0, 'ASIP Beacon');
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: 'network-transmit-receive-symbolic', style_class: 'system-status-icon'});
        this._label = new St.Label({text: 'ASIP', y_align: 2});
        this._box.add_child(this._icon); this._box.add_child(this._label);
        this._button.add_child(this._box);
        this._button.connect('button-press-event', () => {
            try {
                const file = Gio.File.new_for_path(this._path());
                const [ok, bytes] = file.load_contents(null);
                const data = JSON.parse(new TextDecoder().decode(bytes));
                if (ok && data.url && Date.now()/1000 - data.at < 20 && /^http:\/\/127\.0\.0\.1:\d+\/#/.test(data.url))
                    Gio.AppInfo.launch_default_for_uri(data.url, null);
                else Main.notify('ASIP Beacon', 'Service is stopped. Start ASIP from application search.');
            } catch (_) { Main.notify('ASIP Beacon', 'Service is stopped. Start ASIP from application search.'); }
            return true;
        });
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._update();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {this._update(); return GLib.SOURCE_CONTINUE;});
    }
    _path() { return GLib.build_filenamev([GLib.getenv('ASIP_HOME') || GLib.build_filenamev([GLib.get_user_state_dir(), 'asip', 'memory']), 'beacon.json']); }
    _update() {
        try {
            const [ok, bytes] = Gio.File.new_for_path(this._path()).load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            const ready = ok && data.health === 'ready' && Date.now()/1000 - data.at < 20;
            this._label.text = ready ? `ASIP ${data.recent_sessions || 0}` : 'ASIP ·';
            this._icon.icon_name = ready ? 'network-transmit-receive-symbolic' : 'network-offline-symbolic';
            this._button.accessible_name = ready ? `ASIP ready, ${data.recent_sessions || 0} recent agent sessions, ${data.unresolved || 0} unresolved intentions` : 'ASIP service unavailable';
        } catch (_) { this._label.text = 'ASIP ·'; this._icon.icon_name = 'network-offline-symbolic'; }
    }
    disable() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._button?.destroy(); this._button = null;
    }
}
