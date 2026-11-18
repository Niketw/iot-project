"use strict";
/**
 * Climate-control application - written ONCE, only against W3C WoT Thing Descriptions.
 *
 * There is no MQTT, CoAP or HTTP code here and no IP address, port or topic:
 * devices are found by what they ARE (semantic @type) and what they OFFER
 * (property / action / event names). The same file works whether the fan relay
 * speaks CoAP or MQTT, and whether we go through the gateway or talk to devices directly.
 *
 * Rule: temperature > threshold         -> fan ON, heater plug OFF, notify
 *       temperature < threshold - hyst  -> fan OFF, notify
 */
const { runApplication } = require("../lib/app-runtime");

runApplication({
    title: "Climate Controller",

    requires: {
        sensor: { type: "saref:TemperatureSensor", events: ["measurement"] },
        fan: { type: "bldg:FanController", properties: ["on"], actions: ["turnOn", "turnOff"] },
        heater: { type: "bldg:SmartPlug", properties: ["on"], actions: ["turnOff"], optional: true },
    },

    async bind({ sensor, fan, heater }, app) {
        await app.subscribe(sensor, "measurement", async (m) => {
            const { threshold, hysteresis, enabled } = app.settings;
            app.status.temperature = m.temperature;
            app.status.humidity = m.humidity;

            const fanOn = await (await fan.readProperty("on")).value();
            app.status.fanOn = fanOn;
            if (!enabled) return;

            if (m.temperature > threshold && !fanOn) {
                await fan.invokeAction("turnOn");
                app.status.fanOn = true;
                let heaterMsg = "";
                if (heater && (await (await heater.readProperty("on")).value())) {
                    await heater.invokeAction("turnOff");
                    heaterMsg = ", heater plug OFF";
                }
                app.notify(`Too hot: ${m.temperature} °C > ${threshold} °C -> fan ON${heaterMsg}`);
            } else if (m.temperature < threshold - hysteresis && fanOn) {
                await fan.invokeAction("turnOff");
                app.status.fanOn = false;
                app.notify(`Cooled down: ${m.temperature} °C < ${threshold - hysteresis} °C -> fan OFF`);
            }
        });
    },
});
