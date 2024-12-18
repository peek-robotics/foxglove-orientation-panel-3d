import { ExtensionContext } from "@foxglove/extension";

import { initOrientationPanel3D } from "./OrientationPanel3D";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Orientation 3D", initPanel: initOrientationPanel3D });
}
