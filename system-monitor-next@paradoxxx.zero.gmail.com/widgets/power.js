/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { sm_log } from '../utils.js';
import { parse_bytearray } from '../common.js';
import { ElementBase } from '../base.js';

// TUXEDO Control Center daemon: exposes RAPL/GPU power readings over the
// system bus, which lets us show power even when /sys powercap entries are
// restricted to root (as on recent kernels).
const TCCD_BUS_NAME = 'com.tuxedocomputers.tccd';
const TCCD_OBJ_PATH = '/com/tuxedocomputers/tccd';
const TCCD_IFACE = 'com.tuxedocomputers.tccd';

const RAPL_ENERGY_RETRY_POLLS = 30;
const TCCD_RETRY_POLLS = 15;
const PLATFORM_BASE_AC_WATTS = 13.0; // Estimated baseline draw on AC for screen, RAM, SSDs, chipset, and fans

function readSysfsInt(path) {
    try {
        let [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        let value = parseInt(parse_bytearray(contents).trim(), 10);
        return isNaN(value) ? null : value;
    } catch {
        return null;
    }
}

function readSysfsString(path) {
    try {
        let [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        return parse_bytearray(contents).trim();
    } catch {
        return null;
    }
}

const Power = class SystemMonitor_Power extends ElementBase {
    static metadata = {
        name: 'Power',
        metrics: [{key: 'total', color: true}],
        label: 'pwr',
        panelUnit: 'W',
        tooltipUnit: 'W',
        menuLayout: 'detail',
    };

    constructor(extension, config) {
        super(extension, config);

        this._raplDomains = null; // null = not discovered yet
        this._raplLast = new Map();
        this._raplRetryIn = 0;
        this._amdSensors = null;
        this._amdLast = new Map();

        this._batPath = undefined;
        this._tccdOk = null; // null = not probed yet
        this._tccdRetryIn = 0;
        this._tccdCpu = null;
        this._tccdGpu = null;
        this._tccdAssertIn = 0;

        this._askTccdToCollect();
    }

    _askTccdToCollect() {
        // Same switch the TCC GUI flips: makes the daemon start its
        // sensor workers (they idle otherwise).
        this._dbusCall('SetSensorDataCollectionStatus',
            new GLib.Variant('(b)', [true]), () => {});
    }

    _dbusCall(method, parameters, callback) {
        Gio.DBus.system.call(
            TCCD_BUS_NAME, TCCD_OBJ_PATH, TCCD_IFACE, method,
            parameters, null, Gio.DBusCallFlags.NONE, 2000, null,
            (conn, result) => {
                try {
                    let reply = conn.call_finish(result);
                    callback(reply ? reply.deep_unpack()[0] : null);
                } catch {
                    callback(null);
                }
            });
    }

    _discoverRapl() {
        let domains = [];
        try {
            let dir = Gio.File.new_for_path('/sys/class/powercap/');
            let enumerator = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                if (!/^intel-rapl:\d+$/.test(name))
                    continue;
                let basePath = `/sys/class/powercap/${name}`;
                if (readSysfsInt(`${basePath}/energy_uj`) === null)
                    continue; // missing or not readable by this user
                let maxRange = readSysfsInt(`${basePath}/max_energy_range_uj`);
                domains.push({path: basePath, maxRange: maxRange || 2 ** 32});
            }
            enumerator.close(null);
        } catch { /* powercap unavailable */ }
        this._raplDomains = domains;
    }

    _discoverAmd() {
        // amd_energy hwmon chips report whole-package power in microwatts.
        let sensors = [];
        try {
            let dir = Gio.File.new_for_path('/sys/class/hwmon/');
            let enumerator = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let chipPath = `/sys/class/hwmon/${info.get_name()}`;
                if (readSysfsString(`${chipPath}/name`) !== 'amd_energy')
                    continue;
                let value = readSysfsInt(`${chipPath}/power1_input`);
                if (value !== null)
                    sensors.push(`${chipPath}/power1_input`);
            }
            enumerator.close(null);
        } catch { /* hwmon unavailable */ }
        this._amdSensors = sensors;
    }

    // Returns watts consumed by the CPU package, or null when unavailable.
    _sampleDirectPackagePower() {
        if (this._raplDomains === null)
            this._discoverRapl();
        if (this._amdSensors === null)
            this._discoverAmd();

        if (this._raplDomains.length === 0 && this._amdSensors.length === 0) {
            if (this._raplRetryIn-- <= 0) {
                this._raplDomains = null;
                this._amdSensors = null;
                this._raplRetryIn = RAPL_ENERGY_RETRY_POLLS;
            }
            return null;
        }

        let now = GLib.get_monotonic_time();
        let sum = 0;
        let haveSample = false;

        for (let domain of this._raplDomains) {
            let energy = readSysfsInt(`${domain.path}/energy_uj`);
            if (energy === null) {
                // Permissions changed under us; force a rediscovery.
                this._raplDomains = [];
                this._raplLast.clear();
                continue;
            }
            let last = this._raplLast.get(domain.path);
            if (last) {
                let delta = energy - last.energy;
                if (delta < 0)
                    delta += domain.maxRange; // counter wrapped
                let dt = (now - last.time) / 1e6;
                if (dt > 0) {
                    sum += delta / dt;
                    haveSample = true;
                }
            }
            this._raplLast.set(domain.path, {energy: energy, time: now});
        }

        for (let sensorPath of this._amdSensors) {
            let microWatts = readSysfsInt(sensorPath);
            if (microWatts === null) {
                this._amdSensors = [];
                this._amdLast.clear();
                continue;
            }
            sum += microWatts / 1e6;
            haveSample = true;
        }

        return haveSample ? sum : null;
    }

    _discoverBattery() {
        try {
            let dir = Gio.File.new_for_path('/sys/class/power_supply/');
            let enumerator = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (/^BAT\d+$/.test(info.get_name()))
                    return `/sys/class/power_supply/${info.get_name()}`;
            }
        } catch { /* power_supply unavailable */ }
        return null;
    }

    // Battery power flow: positive when discharging, negative when charging.
    _readBattery() {
        if (this._batPath === undefined)
            this._batPath = this._discoverBattery();
        if (!this._batPath)
            return null;

        let status = readSysfsString(`${this._batPath}/status`);
        let microWatts = readSysfsInt(`${this._batPath}/power_now`);
        if (microWatts === null) {
            let volts = readSysfsInt(`${this._batPath}/voltage_now`);
            let amps = readSysfsInt(`${this._batPath}/current_now`);
            if (volts !== null && amps !== null)
                microWatts = volts * amps / 1e6; // µV * µA -> µW
        }
        if (microWatts === null)
            return null;
        return {status: status, watts: microWatts / 1e6};
    }

    _parseTccdJson(json) {
        if (!json)
            return null;
        try {
            return JSON.parse(json);
        } catch {
            return null;
        }
    }

    _queryTccd(done) {
        let pending = 2;
        const finish = () => {
            if (--pending === 0)
                done();
        };
        this._dbusCall('GetCpuPowerValuesJSON', null, value => {
            let parsed = this._parseTccdJson(value);
            if (parsed) {
                // A reply (even powerDraw -1, i.e. "no data yet") proves the
                // daemon is there; only call failures mean it is missing.
                this._tccdOk = true;
                this._tccdCpu = parsed.powerDraw >= 0 ? parsed.powerDraw : null;
            } else {
                this._tccdCpu = null;
            }
            finish();
        });
        this._dbusCall('GetDGpuInfoValuesJSON', null, value => {
            let parsed = this._parseTccdJson(value);
            this._tccdGpu = parsed && parsed.powerDraw >= 0 ? parsed.powerDraw : null;
            finish();
        });
    }

    _isNvidiaSuspended() {
        try {
            let dir = Gio.File.new_for_path('/sys/bus/pci/drivers/nvidia/');
            let enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                if (/^[0-9a-fA-F:.]+$/.test(name)) {
                    let status = readSysfsString(`/sys/bus/pci/drivers/nvidia/${name}/power/runtime_status`);
                    if (status === 'suspended') {
                        enumerator.close(null);
                        return true;
                    }
                }
            }
            enumerator.close(null);
        } catch {}
        return false;
    }

    _sampleDirectGpuPower(callback) {
        if (this._isNvidiaSuspended()) {
            callback(0.0);
            return;
        }

        try {
            let proc = new Gio.Subprocess({
                argv: ['nvidia-smi', '--query-gpu=power.draw', '--format=csv,noheader,nounits'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    let [ok, output] = p.communicate_utf8_finish(result);
                    if (ok && output) {
                        let val = parseFloat(output.trim().split('\n')[0]);
                        callback(isNaN(val) ? null : val);
                        return;
                    }
                } catch {}
                callback(null);
            });
        } catch {
            callback(null);
        }
    }

    _combine(battery, directPower, directGpu) {
        let cpuW = directPower !== null ? directPower : this._tccdCpu;
        let gpuW = this._tccdGpu !== null ? this._tccdGpu : directGpu;

        let total = null;
        let isDischarging = battery && battery.status === 'Discharging';

        if (isDischarging) {
            // On battery the battery itself is the true total draw.
            total = Math.abs(battery.watts);
        } else {
            let parts = [cpuW, gpuW].filter(v => v !== null && v >= 0);
            let metered = parts.reduce((a, b) => a + b, 0);
            let chargeW = (battery && battery.status === 'Charging') ? Math.abs(battery.watts) : 0;
            // On AC: sum metered components (CPU + dGPU) + baseline platform draw + battery charging power
            total = metered + PLATFORM_BASE_AC_WATTS + chargeW;
        }

        const Locale = this.extension._Locale;
        const fmt = v => v === null ? '–'
            : v.toLocaleString(Locale, {maximumFractionDigits: 1, minimumFractionDigits: 1});

        let detail = `CPU ${fmt(cpuW)} · GPU ${fmt(gpuW)}`;
        if (!isDischarging)
            detail += ` · Base ${fmt(PLATFORM_BASE_AC_WATTS)}`;

        if (battery) {
            if (battery.status === 'Charging')
                detail += ` · Batt +${fmt(Math.abs(battery.watts))}`;
            else if (battery.status === 'Discharging')
                detail += ` · Batt -${fmt(Math.abs(battery.watts))}`;
            else
                detail += ` · Batt ${battery.status}`;
        } else {
            detail += ' · Batt –';
        }

        let display = total === null ? '–'
            : total.toLocaleString(Locale, {maximumFractionDigits: 1, minimumFractionDigits: 1});

        return {
            metrics: {total: total === null ? 0 : total},
            display: display,
            detail: detail,
            detailUnit: 'W',
        };
    }

    collectAsync(callback) {
        let battery = this._readBattery();
        let directPower = this._sampleDirectPackagePower();

        // The daemon may idle its sensor workers again (e.g. when the TCC
        // GUI closes), so re-assert collection every minute or so.
        if (this._tccdOk !== false && --this._tccdAssertIn <= 0) {
            this._tccdAssertIn = TCCD_RETRY_POLLS * 2;
            this._askTccdToCollect();
        }

        const collectFinish = (directGpu) => {
            callback(this._combine(battery, directPower, directGpu));
        };

        const queryGpuAndFinish = () => {
            if (this._tccdGpu !== null) {
                collectFinish(null);
            } else {
                this._sampleDirectGpuPower(collectFinish);
            }
        };

        let tccdDue = this._tccdOk !== false;
        if (!tccdDue) {
            if (this._tccdRetryIn > 0) {
                this._tccdRetryIn--;
            } else {
                tccdDue = true;
                this._tccdRetryIn = TCCD_RETRY_POLLS;
            }
        }

        if (!tccdDue) {
            queryGpuAndFinish();
            return;
        }

        this._queryTccd(() => {
            if (this._destroyed) {
                callback(null);
                return;
            }
            if (this._tccdOk === null) {
                // No reply at all means the daemon is not around.
                this._tccdOk = false;
                this._tccdRetryIn = TCCD_RETRY_POLLS;
                sm_log('power: tccd not available, relying on local sensors', 'warn');
            }
            queryGpuAndFinish();
        });
    }
}

export { Power };
