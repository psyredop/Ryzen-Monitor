import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const UPDATE_INTERVAL_SECONDS = 3;

const RyzenMonitorIndicator = GObject.registerClass(
class RyzenMonitorIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Ryzen Monitor');
        
        // Основной контейнер
        this._mainBox = new St.BoxLayout({ 
            style_class: 'radeon-monitor-box',
            reactive: true,
            track_hover: true
        });
        this.add_child(this._mainBox);

        // Создаем контейнеры для каждой метрики
        this._createMetricItem('cpu-symbolic', '—', 'cpu');
        this._mainBox.add_child(this._createSeparator());
        this._createMetricItem('video-display-symbolic', '—', 'gpu');
        this._mainBox.add_child(this._createSeparator());
        this._createMetricItem('drive-memory-symbolic', '—', 'ram');

        // Инициализация переменных состояния
        this._lastCpuTotal = 0;
        this._lastCpuIdle = 0;
        this._timeoutId = null;
        this._gpuSkipCounter = 0;
        this._gpuMethod = 'auto';

        this._startUpdates();
    }

    _createMetricItem(iconName, initialText, metricType) {
        const itemBox = new St.BoxLayout({
            style_class: 'radeon-monitor-item',
            vertical: false
        });

        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon'
        });

        // Просто создаем Label без кастомных стилей - система сама применит нужные
        const label = new St.Label({ 
            text: initialText,
            y_align: Clutter.ActorAlign.CENTER
        });

        itemBox.add_child(icon);
        itemBox.add_child(label);

        // Сохраняем ссылки для обновления
        switch(metricType) {
            case 'cpu':
                this._cpuIcon = icon;
                this._cpuLabel = label;
                break;
            case 'gpu':
                this._gpuIcon = icon;
                this._gpuLabel = label;
                break;
            case 'ram':
                this._ramIcon = icon;
                this._ramLabel = label;
                break;
        }

        this._mainBox.add_child(itemBox);
        return itemBox;
    }

    _createSeparator() {
        return new St.Label({
            text: '·',
            style_class: 'separator-label',
            y_align: Clutter.ActorAlign.CENTER
        });
    }

    _startUpdates() {
        // Первое обновление через 1 секунду для быстрого старта
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._detectGPUMethod();
            this._update();
            
            // Основной цикл обновлений
            this._timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                UPDATE_INTERVAL_SECONDS,
                () => {
                    this._update();
                    return GLib.SOURCE_CONTINUE;
                }
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        this._updateCPU();
        this._updateRAM();
        
        this._gpuSkipCounter++;
        if (this._gpuSkipCounter % 2 === 0) {
            this._updateGPU();
        }
    }

    _updateCPU() {
        try {
            const [success, contents] = GLib.file_get_contents('/proc/stat');
            if (!success) {
                this._cpuLabel.text = 'err';
                this._cpuLabel.add_style_class_name('error');
                return;
            }

            const text = new TextDecoder().decode(contents);
            const cpuLine = text.split('\n')[0];
            const values = cpuLine.split(/\s+/).slice(1, 5).map(Number);
            
            const idle = values[3];
            const total = values.reduce((a, b) => a + b, 0);

            if (this._lastCpuTotal > 0) {
                const totalDiff = total - this._lastCpuTotal;
                const idleDiff = idle - this._lastCpuIdle;
                
                if (totalDiff > 0) {
                    const usage = Math.round((1 - idleDiff / totalDiff) * 100);
                    this._cpuLabel.text = `${usage}%`;
                    this._cpuLabel.remove_style_class_name('error');
                }
            }

            this._lastCpuTotal = total;
            this._lastCpuIdle = idle;
            
        } catch (e) {
            this._cpuLabel.text = 'err';
            this._cpuLabel.add_style_class_name('error');
        }
    }

    _updateRAM() {
        try {
            const [success, contents] = GLib.file_get_contents('/proc/meminfo');
            if (!success) {
                this._ramLabel.text = 'err';
                this._ramLabel.add_style_class_name('error');
                return;
            }

            const text = new TextDecoder().decode(contents);
            let memTotal, memAvailable;

            for (const line of text.split('\n')) {
                if (line.startsWith('MemTotal:')) memTotal = parseInt(line.split(/\s+/)[1]);
                if (line.startsWith('MemAvailable:')) memAvailable = parseInt(line.split(/\s+/)[1]);
                if (memTotal && memAvailable) break;
            }

            if (memTotal && memAvailable) {
                const usage = Math.round(((memTotal - memAvailable) / memTotal) * 100);
                this._ramLabel.text = `${usage}%`;
                this._ramLabel.remove_style_class_name('error');
            } else {
                this._ramLabel.text = 'err';
                this._ramLabel.add_style_class_name('error');
            }
        } catch (e) {
            this._ramLabel.text = 'err';
            this._ramLabel.add_style_class_name('error');
        }
    }

    _detectGPUMethod() {
        if (this._testSysfsGPU()) {
            this._gpuMethod = 'sysfs';
            return;
        }
        
        if (this._testRadeontop()) {
            this._gpuMethod = 'radeontop';
            return;
        }
        
        this._gpuMethod = 'none';
    }

    _testSysfsGPU() {
        try {
            const paths = [
                '/sys/class/drm/card0/device/gpu_busy_percent',
                '/sys/class/drm/card1/device/gpu_busy_percent',
                '/sys/class/drm/card0/device/utilization',
                '/sys/class/hwmon/hwmon1/device/gpu_busy_percent',
                '/sys/class/hwmon/hwmon2/device/gpu_busy_percent'
            ];

            for (const path of paths) {
                try {
                    const [success, contents] = GLib.file_get_contents(path);
                    if (success) {
                        const text = new TextDecoder().decode(contents).trim();
                        if (text && !isNaN(parseInt(text))) {
                            return true;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
        } catch (e) {
            // ignore
        }
        return false;
    }

    _testRadeontop() {
        try {
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(
                'which radeontop'
            );
            return success && exitStatus === 0;
        } catch (e) {
            return false;
        }
    }

    _updateGPU() {
        switch (this._gpuMethod) {
            case 'sysfs':
                this._updateGPUSysfs();
                break;
            case 'radeontop':
                this._updateGPURadeontop();
                break;
            default:
                this._gpuLabel.text = 'n/a';
                this._gpuLabel.add_style_class_name('na');
        }
    }

    _updateGPUSysfs() {
        try {
            const paths = [
                '/sys/class/drm/card0/device/gpu_busy_percent',
                '/sys/class/drm/card1/device/gpu_busy_percent',
                '/sys/class/drm/card0/device/utilization',
                '/sys/class/hwmon/hwmon1/device/gpu_busy_percent',
                '/sys/class/hwmon/hwmon2/device/gpu_busy_percent'
            ];

            for (const path of paths) {
                try {
                    const [success, contents] = GLib.file_get_contents(path);
                    if (success) {
                        const text = new TextDecoder().decode(contents).trim();
                        const usage = parseInt(text);
                        
                        if (!isNaN(usage) && usage >= 0 && usage <= 100) {
                            this._gpuLabel.text = `${usage}%`;
                            this._gpuLabel.remove_style_class_name('error');
                            this._gpuLabel.remove_style_class_name('na');
                            return;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
            
            this._gpuLabel.text = 'n/a';
            this._gpuLabel.add_style_class_name('na');
            
        } catch (e) {
            this._gpuLabel.text = 'err';
            this._gpuLabel.add_style_class_name('error');
        }
    }

    _updateGPURadeontop() {
        try {
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(
                'timeout 2 radeontop --limit 1 --dump - 2>/dev/null'
            );
            
            if (success && exitStatus === 0) {
                const output = new TextDecoder().decode(stdout);
                const lines = output.trim().split('\n');
                
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i].trim();
                    if (line && line.includes('gpu')) {
                        const gpuMatch = line.match(/gpu\s+([0-9.]+)%/i);
                        if (gpuMatch) {
                            const usage = Math.round(parseFloat(gpuMatch[1]));
                            this._gpuLabel.text = `${usage}%`;
                            this._gpuLabel.remove_style_class_name('error');
                            this._gpuLabel.remove_style_class_name('na');
                            return;
                        }
                    }
                }
            }
            
            this._gpuLabel.text = 'n/a';
            this._gpuLabel.add_style_class_name('na');
            
        } catch (e) {
            this._gpuLabel.text = 'err';
            this._gpuLabel.add_style_class_name('error');
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        super.destroy();
    }
});

export default class RyzenMonitorExtension {
    constructor() {
        this._indicator = null;
    }

    enable() {
        this._indicator = new RyzenMonitorIndicator();
        Main.panel.addToStatusArea('ryzen-monitor', this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}