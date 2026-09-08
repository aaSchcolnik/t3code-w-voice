import { expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS } from "./providerDriverMeta";

it("defines each provider driver exactly once", () => {
  const drivers = DRIVER_OPTIONS.map((definition) => definition.value);

  expect(drivers).toHaveLength(new Set(drivers).size);
  expect(drivers.filter((driver) => driver === "antigravity")).toHaveLength(1);
});
