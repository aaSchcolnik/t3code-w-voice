import { useCallback, type ComponentType } from "react";
import {
  ArchiveIcon,
  ChartNoAxesColumnIncreasingIcon,
  ArrowLeftIcon,
  BotIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  KeyboardIcon,
  LibraryBigIcon,
  Link2Icon,
  Mic2Icon,
  PaletteIcon,
  PlugZapIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { T3ConnectSidebarAvatar, T3ConnectSidebarSignIn } from "../clerk/T3ConnectSidebarSignIn";
import { Badge } from "../ui/badge";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/usage"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/voice"
  | "/settings/beta"
  | "/settings/mcp"
  | "/settings/knowledge"
  | "/settings/skills"
  | "/settings/archived";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Appearance", to: "/settings/appearance", icon: PaletteIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Providers", to: "/settings/providers", icon: BotIcon },
  { label: "Usage", to: "/settings/usage", icon: ChartNoAxesColumnIncreasingIcon },
  { label: "MCP", to: "/settings/mcp", icon: PlugZapIcon },
  { label: "Skills", to: "/settings/skills", icon: SparklesIcon },
  { label: "Knowledge", to: "/settings/knowledge", icon: LibraryBigIcon },
  { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
  { label: "Connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Voice", to: "/settings/voice", icon: Mic2Icon },
  { label: "Beta", to: "/settings/beta", icon: FlaskConicalIcon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const knowledgeProjects = useEnvironmentQuery(
    environmentId ? serverEnvironment.knowledgeListProjects({ environmentId, input: {} }) : null,
  );
  const pendingKnowledgeCount = (knowledgeProjects.data ?? []).reduce(
    (total, project) => total + project.pendingCount,
    0,
  );
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="p-2">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => handleSectionClick(item.to)}
                  >
                    <Icon />
                    <span className="truncate">{item.label}</span>
                    {item.to === "/settings/knowledge" && pendingKnowledgeCount > 0 ? (
                      <Badge size="sm" variant="warning" className="ml-auto">
                        {pendingKnowledgeCount}
                      </Badge>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <T3ConnectSidebarSignIn />
        <div className="flex items-center gap-1">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleBackClick}>
                <ArrowLeftIcon />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <T3ConnectSidebarAvatar />
        </div>
      </SidebarFooter>
    </>
  );
}
