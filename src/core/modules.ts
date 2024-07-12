import * as block from "./block";
import * as communicate from "./communicate";
import {eventBus} from "./eventbus";
import {filter} from "./filtering";
import Frame from "./frame";
import * as memo from "./memo";
import * as settings from "./settings";
import DeepProxy from "../utils/deepProxy";
import * as dom from "../utils/dom";
import * as http from "../utils/http";
import * as ip from "../utils/ip";
import storage from "../utils/storage";
import browser from "webextension-polyfill";

type ModuleItem =
    | RefresherFilter
    | typeof Frame
    | RefresherEventBus
    | RefresherHTTP
    | RefresherIP
    | RefresherBlock
    | RefresherDOM
    | RefresherMemo;

export type ModuleStore = Record<string, RefresherModule>;

const UTILS: Record<string, ModuleItem> = {
    filter,
    Frame,
    eventBus,
    http,
    ip,
    block,
    dom,
    memo
};

const module_store: ModuleStore = {};

const runModule = (module: RefresherModule) => {
    const plugins: ModuleItem[] = [];

    if (Array.isArray(module.require)) {
        for (const require of module.require) {
            plugins.push(UTILS[require]);
        }
    }

    if (typeof module.func === "function") module.func.bind(module)(...plugins);
};

const revokeModule = (mod: RefresherModule) => {
    if (typeof mod.revoke === "function") {
        const plugins: ModuleItem[] = [];

        if (Array.isArray(module.require)) {
            for (const require of module.require) {
                plugins.push(UTILS[require]);
            }
        }

        mod.revoke.bind(mod)(...plugins);
    }

    if (typeof mod.memory === "object") {
        for (const key in mod.memory) {
            mod.memory[key] = undefined;
        }
    }
};

export const modules = {
    lists: (): ModuleStore => module_store,
    load: (...mods: RefresherModule[]): Promise<void> => {
        return new Promise<void>((resolve) =>
            Promise.all(mods.map(modules.register)).then(() => resolve())
        );
    },
    register: async (mod: RefresherModule): Promise<void> => {
        const start = performance.now();

        if (module_store[mod.name]) throw `${mod.name} is already registered.`;

        const checkEnabled = storage.get<boolean | undefined>(`${mod.name}.enable`)
            .then((enable) => {
                if (enable === undefined) {
                    storage.set(`${mod.name}.enable`, mod.default_enable);
                    mod.enable = mod.default_enable;
                } else {
                    mod.enable = enable;
                }
            });

        if (typeof mod.settings === "object") {
            mod.status ??= {};

            const promises = Object.keys(mod.settings).map(async (key) => {
                mod.status[key] = await settings.load(mod.name, key, mod.settings[key]);
            });

            await Promise.all(promises);
        }

        if (typeof mod.data === "object") {
            for (const key in mod.data) {
                mod.data[key] =
                    (await storage.module.get(mod.name)) ?? mod.data[key];
            }

            mod.data = (await storage.module.get(mod.name)) ?? {};

            mod.data = new DeepProxy(mod.data, {
                set(): boolean {
                    storage.module.setGlobal(
                        mod.name,
                        JSON.stringify(mod.data)
                    );
                    return true;
                },

                deleteProperty(): boolean {
                    storage.module.setGlobal(
                        mod.name,
                        JSON.stringify(mod.data)
                    );
                    return true;
                }
            });
        }

        module_store[mod.name] = mod;
        await checkEnabled;

        const stringify = JSON.stringify({
            module_store,
            settings_store: settings.dump()
        });

        browser.runtime.sendMessage(stringify);

        if (!mod.enable) {
            console.log(`📁 ignoring ${mod.name}. The module is disabled.`);
            return;
        }

        if (mod.url && !mod.url.test(location.href)) {
            console.log(
                `📁 ignoring ${mod.name}. current URL is not matching with the module's URL value.`
            );
            return;
        }

        runModule(mod);

        console.log(
            `📁 ${mod.name} module loaded. took ${(
                performance.now() - start
            ).toFixed(2)}ms.`
        );
    }
};

communicate.addHook("updateModuleStatus", (data) => {
    module_store[data.name].enable = data.value as boolean;
    storage.set(`${data.name}.enable`, data.value);

    browser.runtime.sendMessage(
        JSON.stringify({
            module_store
        })
    );

    if (!data.value) {
        revokeModule(module_store[data.name]);
        return;
    }

    runModule(module_store[data.name]);
});

communicate.addHook("updateSettingValue", (data) => {
    settings.setStore(data.name, data.key, data.value);
});

communicate.addHook("executeShortcut", (data) => {
    console.log(`Received shortcut execute: ${data}.`);

    for (const key of Object.keys(module_store)) {
        if (
            module_store[key] &&
            typeof module_store[key].shortcuts === "object" &&
            typeof module_store[key].shortcuts![data] === "function"
        ) {
            module_store[key].shortcuts![data].bind(module_store[key])();
        }
    }
});

// 설정 창에서 설정을 변경할 경우 실행되는 함수를 정의합니다.
eventBus.on(
    "refresherUpdateSetting",
    (module: string, key: string, value: unknown) => {
        const mod = module_store[module];

        if (mod !== undefined) {
            mod.status ??= {};
            mod.status[key] = value;
        }

        // 모듈이 활성화되지 않은 상태일 경우 모듈 설정 업데이트 함수 호출을 건너뜁니다.
        if (!mod.enable || !mod.update || typeof mod.update[key] !== "function")
            return;

        const plugins: ModuleItem[] = [];

        if (Array.isArray(mod.require)) {
            for (const require of mod.require) {
                plugins.push(UTILS[require]);
            }
        }

        mod.update[key].bind(mod)(value, ...plugins);
    }
);
