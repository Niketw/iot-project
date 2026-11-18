"use strict";
/**
 * Climate-control application - written ONCE, only against W3C WoT Thing Descriptions.
 *
 * There is no MQTT, CoAP or HTTP code here and no IP address, port or topic:
 * devices are found by what they ARE (semantic @type) and what they OFFER
 * (property / action / event names). The same file works whether the fan relay
 * speaks CoAP or MQTT, and whether we go through the gateway or talk to devices directly.
 *
 * Rule (checked on every measurement):
 *   temperature > threshold               -> fan ON,  heater plug OFF   (cooling)
 *   temperature < threshold - hysteresis  -> fan OFF, heater plug ON    (heating)
 *   in between (the hysteresis band)      -> leave both as they are
 * Each device is only switched when its actual state differs, and a notification
 * is sent whenever something was switched.
 */
const { runApplication } = require("../lib/app-runtime");

runApplication({
    title: "Climate Controller",

    requires: {
        sensor: { type: "saref:TemperatureSensor", events: ["measurement"] },
        fan: { type: "bldg:FanController", properties: ["on"], actions: ["turnOn", "turnOff"] },
        heater: { type: "bldg:SmartPlug", properties: ["on"], actions: ["turnOn", "turnOff"], optional: true },
    },

    async bind({ sensor, fan, heater }, app) {
        const read = async (thing, prop) => (await thing.readProperty(prop)).value();

        await app.subscribe(sensor, "measurement", async (m) => {
            const { threshold, hysteresis, enabled } = app.settings;
            const t = m.temperature;
            app.status.temperature = t;
            app.status.humidity = m.humidity;

            const fanOn = await read(fan, "on");
            const heaterOn = heater ? await read(heater, "on") : null;
            app.status.fanOn = fanOn;
            app.status.heaterOn = heaterOn;
            if (!enabled) return;

            let want; // desired state, or undefined inside the hysteresis band
            if (t > threshold) want = { fan: true, heater: false, why: `Too hot: ${t} °C > ${threshold} °C` };
            else if (t < threshold - hysteresis) want = { fan: false, heater: true, why: `Cooled down: ${t} °C < ${threshold - hysteresis} °C` };
            if (!want) return;

            const switched = [];
            if (fanOn !== want.fan) {
                await fan.invokeAction(want.fan ? "turnOn" : "turnOff");
                app.status.fanOn = want.fan;
                switched.push(`fan ${want.fan ? "ON" : "OFF"}`);
            }
            if (heater && heaterOn !== want.heater) {
                await heater.invokeAction(want.heater ? "turnOn" : "turnOff");
                app.status.heaterOn = want.heater;
                switched.push(`heater plug ${want.heater ? "ON" : "OFF"}`);
            }
            if (switched.length) app.notify(`${want.why} -> ${switched.join(", ")}`);
        });
    },
});
