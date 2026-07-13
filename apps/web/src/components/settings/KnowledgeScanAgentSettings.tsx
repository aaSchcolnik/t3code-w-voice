import { useAtomValue } from "@effect/atom-react";
import { resolveDelegationRoles, type EngineDelegationTarget } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ChainEditor, ModelPreferenceEditor } from "./EngineDelegationSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function CollapseToggle({ open, label }: { open: boolean; label: string }) {
  return (
    <CollapsibleTrigger
      render={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
        />
      }
    >
      {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
    </CollapsibleTrigger>
  );
}

export function KnowledgeScanAgentSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providerEntries = deriveProviderInstanceEntries(useAtomValue(primaryServerProvidersAtom));
  const [scannerOpen, setScannerOpen] = useState(false);
  const [modelPreferenceOpen, setModelPreferenceOpen] = useState(false);
  const resolvedScanner = resolveDelegationRoles(
    settings.mcp.engine.delegation,
    new Set(["codex", "cursor", "inline"] as const),
  ).scanner;
  const explicitScanner = settings.mcp.engine.delegation.roles.scanner;

  const updateScanner = (scanner: ReadonlyArray<EngineDelegationTarget> | undefined) => {
    const roles = { ...settings.mcp.engine.delegation.roles };
    if (scanner === undefined) delete roles.scanner;
    else roles.scanner = scanner;
    updateSettings({
      mcp: {
        ...settings.mcp,
        engine: {
          ...settings.mcp.engine,
          delegation: { ...settings.mcp.engine.delegation, roles },
        },
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          Codebase scan agents
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure the parallel scanner panel and the model used by the Judge thread when T3 Code
          scans a project for knowledge.
        </p>
      </div>
      <SettingsSection title="Scan configuration">
        <Collapsible open={scannerOpen} onOpenChange={setScannerOpen}>
          <SettingsRow
            className="pb-3.5"
            title="Scanner panel"
            description="Every available scanner runs in parallel; the inline target is the Judge's own pass."
            status={explicitScanner === undefined ? "Automatic defaults" : "Customized"}
            control={
              <>
                {explicitScanner === undefined ? null : (
                  <Button variant="outline" onClick={() => updateScanner(undefined)}>
                    Restore automatic
                  </Button>
                )}
                <CollapseToggle open={scannerOpen} label="scanner panel" />
              </>
            }
          >
            <CollapsiblePanel>
              <div className="pt-4">
                <ChainEditor
                  chain={resolvedScanner}
                  providerEntries={providerEntries}
                  role="scanner"
                  onChange={updateScanner}
                />
              </div>
            </CollapsiblePanel>
          </SettingsRow>
        </Collapsible>
        <Collapsible open={modelPreferenceOpen} onOpenChange={setModelPreferenceOpen}>
          <SettingsRow
            className="pb-3.5"
            title="Scan thread model preference"
            description="Ordered fallback list for the Judge thread created by Scan codebase. The first usable provider and model is selected."
            control={
              <CollapseToggle open={modelPreferenceOpen} label="scan thread model preference" />
            }
          >
            <CollapsiblePanel>
              <div className="pt-4">
                <ModelPreferenceEditor
                  preference={settings.mcp.engine.knowledgeScan.mainThreadModelPreference}
                  providerEntries={providerEntries}
                  onChange={(mainThreadModelPreference) =>
                    updateSettings({
                      mcp: {
                        ...settings.mcp,
                        engine: {
                          ...settings.mcp.engine,
                          knowledgeScan: { mainThreadModelPreference },
                        },
                      },
                    })
                  }
                />
              </div>
            </CollapsiblePanel>
          </SettingsRow>
        </Collapsible>
      </SettingsSection>
    </div>
  );
}
