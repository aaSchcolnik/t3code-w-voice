import { expect, it } from "vite-plus/test";

import { PROVIDER_CLIENT_DEFINITIONS } from "./providerDriverMeta";

it("defines each provider driver exactly once", () => {
  const drivers = PROVIDER_CLIENT_DEFINITIONS.map((definition) => definition.value);

  expect(drivers).toHaveLength(new Set(drivers).size);
  expect(drivers.filter((driver) => driver === "antigravity")).toHaveLength(1);
});
