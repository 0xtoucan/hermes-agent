/**
 * The `@hermes/plugin-sdk` surface that lives INSIDE the sandbox frame.
 *
 * vite.config.ts (`hermes:sandbox-vendor`) builds this file with a nested
 * library build — React external, mapped to the frame's `__HERMES_REACT__`
 * globals — and frame-document.ts inlines the result as text, the same way
 * the React CJS bundles are. So every component here renders in the guest
 * document with the guest's React, against the host stylesheet the frame
 * mirrors.
 *
 * Three things are aliased to guest twins in that build (see
 * `SANDBOX_GUEST_ALIASES`): `@/i18n` (the host bridges locale + a catalog
 * slice), `@/lib/haptics` (a bridge call) and the keybind-hint hook (no
 * binding store in the frame). Everything else is the real module, so a
 * plugin's Dialog is core's Dialog.
 *
 * NOT here, by design: `host.*`, `ctx.*`, `useValue`/`atom` over host state
 * (guest-runtime.js owns those, they are the boundary), and the components
 * that reach app stores (SkillsView, McpTab, ModelCatalogMenu,
 * SessionStatusDot, ToolsetConfigPanel, MessageTextContent, Contribute,
 * useTheme/requestTheme, session-unread, accent override). Those keep the
 * runtime's "not available to sandboxed plugins" error.
 */

export { $appStrings, $locale } from './bridge'
export { reviveAppStrings } from './i18n'
// -- pure helpers ---------------------------------------------------------------
export { nextRunOverdueMs } from '@/app/cron/job-state'
export {
  PanelAction,
  PanelAddButton,
  PanelBlock,
  PanelBody,
  PanelDetail,
  PanelEmpty,
  PanelHeader,
  PanelList,
  PanelListRow,
  PanelMeta,
  PanelPill,
  PanelRowMenu,
  PanelSectionLabel
} from '@/app/overlays/panel'
export { Wordmark } from '@/components/chat/wordmark'
// -- ui -----------------------------------------------------------------------
export { StatusDot, type StatusTone } from '@/components/status-dot'
export { Badge } from '@/components/ui/badge'
export { Button } from '@/components/ui/button'
export { Checkbox } from '@/components/ui/checkbox'
export { Codicon } from '@/components/ui/codicon'
export { ColorSwatches } from '@/components/ui/color-swatches'
export { ConfirmDialog } from '@/components/ui/confirm-dialog'
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
export { CopyButton } from '@/components/ui/copy-button'
export { DecodeText } from '@/components/ui/decode-text'
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
export { DisclosureCaret } from '@/components/ui/disclosure-caret'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
export { EmptyState } from '@/components/ui/empty-state'
export { ErrorState } from '@/components/ui/error-state'
export { FadeScroll } from '@/components/ui/fade-scroll'
export { GlyphSpinner } from '@/components/ui/glyph-spinner'
export { Input } from '@/components/ui/input'
export { Kbd, KbdGroup } from '@/components/ui/kbd'
export { Loader, type LoaderType } from '@/components/ui/loader'
export { LogView } from '@/components/ui/log-view'
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
export { RowButton } from '@/components/ui/row-button'
export { ScrollArea } from '@/components/ui/scroll-area'
export { SearchField } from '@/components/ui/search-field'
export { SegmentedControl } from '@/components/ui/segmented-control'
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
export { Separator } from '@/components/ui/separator'
export { Skeleton } from '@/components/ui/skeleton'
export { Switch } from '@/components/ui/switch'
export { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
// `Streamdown` ships as its own opt-in chunk (streamdown-entry.ts, +450 KB):
// the frame carries it only when the plugin source imports it.

export { Textarea } from '@/components/ui/textarea'
export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
export { createPluginI18n, translateNow, useI18n, usePluginI18n } from '@/i18n'
export { type BudgetedLoop, type BudgetedLoopOptions, createBudgetedLoop } from '@/lib/budgeted-loop'
// -- i18n (guest twin) + haptics (bridged) -------------------------------------
export { triggerHaptic as haptic } from '@/lib/haptics'
export * as icons from '@/lib/icons'
export { isSubmitEnter } from '@/lib/ime'
export { formatModifierToken } from '@/lib/keybinds/combo'
export { LruCache } from '@/lib/lru-cache'
export { PROFILE_SWATCHES, profileColor, profileColorSoft } from '@/lib/profile-color'
export { reasoningEffortLabel } from '@/lib/reasoning-effort'
export { evaluateRuntimeReadiness } from '@/lib/runtime-readiness'
export { coarseElapsed, fmtDateTime, fmtDayTime, formatAgo, relativeTime } from '@/lib/time'
export { cn } from '@/lib/utils'
export {
  hexToOklch,
  hueDelta,
  maxChroma,
  mixOklab,
  normalizeHex,
  oklchToHex,
  oklchToSrgb255,
  readableInk as readableOn
} from '@/themes/color'
export { retintTheme, themeHue } from '@/themes/retint'

export { compactNumber, DEFAULT_REASONING_EFFORT, REASONING_EFFORT_VALUES, REASONING_EFFORTS } from '@hermes/shared'
export { contrastRatio } from '@hermes/shared/color'
// -- state + data ---------------------------------------------------------------
export { useStore as useValue } from '@nanostores/react'

export { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
export { blobatar as blobatarSvg } from 'blobatar/blob'
export { Blobatar } from 'blobatar/react'
export { atom, computed } from 'nanostores'

// -- area constants -------------------------------------------------------------
// Literals, not imports: core's area modules sit next to the registry and the
// composer/route stores, which have no business in the frame. `guest-sdk.test.ts`
// pins every value to the real SDK export so they cannot drift.
export const PANES_AREA = 'panes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' } as const
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' } as const
export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'
export const THEMES_AREA = 'themes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const WORKSPACE_PAGE_HEADER_AREA = 'workspace.pageHeader'
export const CHAT_EMPTY_AREA = 'chat.empty'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'

export const COMPOSER_AREAS = {
  top: 'composer.top',
  bottom: 'composer.bottom',
  underside: 'composer.underside',
  leading: 'composer.leading',
  actions: 'composer.actions',
  middleware: 'composer.middleware',
  attachments: 'composer.attachments',
  microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions'
} as const
