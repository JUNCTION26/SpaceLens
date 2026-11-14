import { Icon } from './icons';
import { GROUPS, NAV, useUi, type NavItem } from './uiStore';
import { useStore } from '../core/store';

/** One slim rail: five destinations, each opening its last-used section. */
export function Sidebar({ active }: { active: NavItem }) {
  const openGroup = useUi((s) => s.openGroup);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const online = useStore((s) => Boolean(s.settings.geminiKey));
  return (
    <nav className="sidebar" aria-label="Sections">
      <div className="sidebar-scroll">
        {GROUPS.map((g) => (
          <button key={g.key} data-group={g.key} className={`rail-item${g.key === active.group ? ' on' : ''}`}
            aria-current={g.key === active.group ? 'page' : undefined} onClick={() => openGroup(g.key)}>
            <Icon name={g.icon} size={20} /><span>{g.key}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="icon-btn" onClick={() => window.dispatchEvent(new Event('spacelens:demo'))} title="Guided demo" aria-label="Guided demo">
          <Icon name="play" size={16} />
        </button>
        <button className="icon-btn rail-settings" onClick={() => setSettingsOpen(true)} title={online ? 'Settings · Gemini' : 'Settings · Offline'} aria-label={`Settings, ${online ? 'Gemini on' : 'offline'}`}>
          <Icon name="settings" size={16} /><i className={online ? 'ok' : ''} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

/** Second level: a quiet segmented control inside the panel. Hidden when a group has one section. */
export function SectionTabs({ active }: { active: NavItem }) {
  const open = useUi((s) => s.openSection);
  const items = NAV.filter((n) => n.group === active.group);
  if (items.length < 2) return null;
  return (
    <div className="seg section-seg" role="tablist" aria-label={active.group}>
      {items.map((n) => (
        <button key={n.key} role="tab" data-nav={n.key} aria-selected={n.key === active.key} className={n.key === active.key ? 'on' : ''}
          title={n.hint} onClick={() => open(n.key)}>{n.label}</button>
      ))}
    </div>
  );
}

export function MobileNav({ active }: { active: NavItem }) {
  const openGroup = useUi((s) => s.openGroup);
  return (
    <nav className="mobile-tabs" aria-label="Sections">
      {GROUPS.map((g) => (
        <button key={g.key} className={g.key === active.group ? 'on' : ''} aria-current={g.key === active.group ? 'page' : undefined} onClick={() => openGroup(g.key)}>
          <Icon name={g.icon} size={20} /><span>{g.key}</span>
        </button>
      ))}
    </nav>
  );
}
