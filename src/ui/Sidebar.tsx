import { useState } from 'react';
import { Icon } from './icons';
import { NAV, useUi, type NavItem } from './uiStore';

const GROUPS = [...new Set(NAV.map((n) => n.group))];
/** Phone tab bar: most used sections; the rest sit under More. */
const PRIMARY = ['capture', 'describe', 'layouts', 'walk', 'export'];

export function Sidebar({ active }: { active: NavItem }) {
  const collapsed = useUi((s) => s.navCollapsed);
  const toggle = useUi((s) => s.toggleNav);
  const open = useUi((s) => s.openSection);
  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Sections">
      <div className="sidebar-scroll">
        {GROUPS.map((g) => (
          <div key={g} className="nav-group">
            <div className="nav-label">{g}</div>
            {NAV.filter((n) => n.group === g).map((n) => (
              <button key={n.key} data-nav={n.key} className={`nav-item${n.key === active.key ? ' on' : ''}`} aria-current={n.key === active.key ? 'page' : undefined}
                title={collapsed ? n.label : n.hint} onClick={() => open(n.key)}>
                <Icon name={n.icon} size={16} /><span>{n.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="nav-link" onClick={() => window.dispatchEvent(new Event('spacelens:demo'))} title="Guided demo">
          <Icon name="play" size={14} /><span>Guided demo</span>
        </button>
        <button className="icon-btn nav-collapse" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Icon name="panelLeft" size={16} />
        </button>
      </div>
    </nav>
  );
}

export function MobileNav({ active }: { active: NavItem }) {
  const open = useUi((s) => s.openSection);
  const [more, setMore] = useState(false);
  const primary = NAV.filter((n) => PRIMARY.includes(n.key));
  const rest = NAV.filter((n) => !PRIMARY.includes(n.key));
  const inRest = rest.some((n) => n.key === active.key);
  return (
    <>
      {more && (
        <div className="mobile-more" role="menu" onClick={() => setMore(false)}>
          <div className="mobile-more-sheet" onClick={(e) => e.stopPropagation()}>
            {rest.map((n) => (
              <button key={n.key} role="menuitem" className={`nav-item${n.key === active.key ? ' on' : ''}`} onClick={() => { open(n.key); setMore(false); }}>
                <Icon name={n.icon} size={18} /><span>{n.label}</span>
              </button>
            ))}
            <button role="menuitem" className="nav-item" onClick={() => { setMore(false); window.dispatchEvent(new Event('spacelens:demo')); }}>
              <Icon name="play" size={18} /><span>Guided demo</span>
            </button>
          </div>
        </div>
      )}
      <nav className="mobile-tabs" aria-label="Sections">
        {primary.map((n) => (
          <button key={n.key} className={n.key === active.key ? 'on' : ''} aria-current={n.key === active.key ? 'page' : undefined} onClick={() => { open(n.key); setMore(false); }}>
            <Icon name={n.icon} size={20} /><span>{n.label.split(' ')[0]}</span>
          </button>
        ))}
        <button className={inRest || more ? 'on' : ''} aria-expanded={more} onClick={() => setMore(!more)}>
          <Icon name="more" size={20} /><span>More</span>
        </button>
      </nav>
    </>
  );
}
