import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks !== "function") {
	throw new Error("Fast tests require Node 22.15+; use npm run test:serial with older Node versions.");
}

const adapters = new Map([
	["@earendil-works/pi-ai", new URL("../tests/stubs/pi-ai.ts", import.meta.url).href],
	["@earendil-works/pi-coding-agent", new URL("../tests/stubs/pi-coding-agent.ts", import.meta.url).href],
	["@earendil-works/pi-tui", new URL("../tests/stubs/pi-tui.ts", import.meta.url).href],
]);

nodeModule.registerHooks({
	resolve(specifier, context, nextResolve) {
		// The host-loader integration imports real package submodules. Keep the
		// lightweight stubs for project extensions, but do not feed them back into
		// the packages' own real modules.
		if (specifier.startsWith("@earendil-works/") && context.parentURL?.includes("/node_modules/@earendil-works/")) {
			return nextResolve(specifier, context);
		}
		const url = adapters.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
