import { AlertCircle, Lightbulb, AlertTriangle, Info, Flame, type LucideIcon } from 'lucide-react';

export interface CalloutDefinition {
  type: string;
  label: string;
  icon: LucideIcon;
  /** CSS variable name pairs: [bg token, border token] — defined in index.css */
  colorKey: string;
}

/**
 * Registry of all callout types. Add new ones here and they'll
 * automatically appear in slash commands and the viewer.
 *
 * Each `colorKey` maps to CSS classes: `callout-<colorKey>` defined in index.css.
 */
export const calloutRegistry: CalloutDefinition[] = [
  { type: 'NOTE',      label: 'Note',      icon: Info,           colorKey: 'note' },
  { type: 'TIP',       label: 'Tip',       icon: Lightbulb,      colorKey: 'tip' },
  { type: 'IMPORTANT', label: 'Important', icon: AlertCircle,    colorKey: 'important' },
  { type: 'WARNING',   label: 'Warning',   icon: AlertTriangle,  colorKey: 'warning' },
  { type: 'CAUTION',   label: 'Caution',   icon: Flame,          colorKey: 'caution' },
];

/** Lookup by type string (case-insensitive) */
export function getCalloutDef(type: string): CalloutDefinition | undefined {
  return calloutRegistry.find((c) => c.type === type.toUpperCase());
}

/** All supported type strings, for regex matching */
export function calloutTypePattern(): string {
  return calloutRegistry.map((c) => c.type).join('|');
}
