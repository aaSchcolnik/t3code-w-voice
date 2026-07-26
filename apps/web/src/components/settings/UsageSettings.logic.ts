export function isUsageRefreshShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  return (
    event.key.toLowerCase() === "u" &&
    event.shiftKey &&
    !event.altKey &&
    (event.metaKey || event.ctrlKey)
  );
}

export function isEditableUsageShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}
