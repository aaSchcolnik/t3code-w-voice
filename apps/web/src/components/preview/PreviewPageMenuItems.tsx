import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";

/** Page actions have the same layout for a native guest and a streamed guest. */
export function PreviewPageMenuItems({
  disabled,
  zoomFactor,
  colorScheme,
  onAction,
  onColorScheme,
  children,
}: {
  disabled: boolean;
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  onAction: (action: "hardReload" | "zoomIn" | "zoomOut" | "resetZoom") => void;
  onColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <MenuItem onClick={() => onAction("hardReload")} disabled={disabled}>
        Hard reload
      </MenuItem>
      {children}
      <MenuSub>
        <MenuSubTrigger disabled={disabled}>Appearance</MenuSubTrigger>
        <MenuSubPopup className="min-w-32">
          <MenuRadioGroup
            value={colorScheme}
            onValueChange={(value) => onColorScheme(value as DesktopPreviewColorScheme)}
          >
            <MenuRadioItem value="system">System</MenuRadioItem>
            <MenuRadioItem value="light">Light</MenuRadioItem>
            <MenuRadioItem value="dark">Dark</MenuRadioItem>
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
      <MenuItem
        closeOnClick={false}
        onClick={(event: React.MouseEvent) => event.preventDefault()}
        className="justify-between"
        disabled={disabled}
      >
        <span>Zoom</span>
        <span className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            type="button"
            onClick={() => onAction("zoomOut")}
            aria-label="Zoom out"
            disabled={disabled}
          >
            <Minus />
          </Button>
          <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(zoomFactor * 100)}%
          </span>
          <Button
            variant="outline"
            size="icon-xs"
            type="button"
            onClick={() => onAction("zoomIn")}
            aria-label="Zoom in"
            disabled={disabled}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            onClick={() => onAction("resetZoom")}
            aria-label="Reset zoom"
            disabled={disabled}
          >
            <RotateCcw />
          </Button>
        </span>
      </MenuItem>
    </>
  );
}
