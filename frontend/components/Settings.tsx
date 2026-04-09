/// <reference types="react" />

// Available colors for the side tab button
export const TAB_COLORS = [
  { id: 'gray',  label: 'Gray',   bg: 'rgba(255,255,255,0.12)', bgHover: 'rgba(255,255,255,0.22)', arrow: 'rgba(255,255,255,0.7)' },
  { id: 'black', label: 'Black',  bg: 'rgba(0,0,0,0.75)',       bgHover: 'rgba(0,0,0,0.9)',        arrow: 'rgba(255,255,255,0.7)' },
  { id: 'white', label: 'White',  bg: 'rgba(255,255,255,0.85)', bgHover: 'rgba(255,255,255,1)',    arrow: 'rgba(0,0,0,0.7)'       },
  { id: 'blue',  label: 'Blue',   bg: 'rgba(76,158,255,0.7)',   bgHover: 'rgba(76,158,255,0.9)',   arrow: 'rgba(255,255,255,0.9)' },
  { id: 'red',   label: 'Red',    bg: 'rgba(224,82,82,0.7)',    bgHover: 'rgba(224,82,82,0.9)',    arrow: 'rgba(255,255,255,0.9)' },
];

export function getTabColor(id: string) {
  return TAB_COLORS.find(c => c.id === id) ?? TAB_COLORS[0];
}

export const AutoShutdownSettings = ({
  tabColor, showOverlay, panelSide, tabStyle, shutdownAction,
  onTabColor, onShowOverlay, onPanelSide, onTabStyle, onShutdownAction,
}: {
  tabColor: string;
  showOverlay: boolean;
  panelSide: 'left' | 'right';
  tabStyle: 'slim' | 'large' | 'floating';
  shutdownAction: 'shutdown' | 'sleep';
  onTabColor: (v: string) => void;
  onShowOverlay: (v: boolean) => void;
  onPanelSide: (v: 'left' | 'right') => void;
  onTabStyle: (v: 'slim' | 'large' | 'floating') => void;
  onShutdownAction: (v: 'shutdown' | 'sleep') => void;
}) => {
  const react = (window as any).SP_REACT as typeof import('react');

  const [color, setColor]           = react.useState(tabColor);
  const [overlay, setOverlay]       = react.useState(showOverlay);
  const [side, setSide]             = react.useState(panelSide);
  const [style, setStyle]           = react.useState(tabStyle);
  const [action, setAction]         = react.useState(shutdownAction);

  const [ddColor, setDdColor]   = react.useState(false);
  const [ddStyle, setDdStyle]   = react.useState(false);
  const [ddSide, setDdSide]     = react.useState(false);
  const [ddAction, setDdAction] = react.useState(false);

  function pickColor(id: string) { setColor(id); setDdColor(false); onTabColor(id); }
  function pickStyle(s: string)  { setStyle(s as any); setDdStyle(false); onTabStyle(s as any); }
  function pickAction(a: string) { setAction(a as any); setDdAction(false); onShutdownAction(a as any); }
  function pickSide(s: string)   { setSide(s as any); setDdSide(false); onPanelSide(s as any); }
  function flipOverlay()         { const v = !overlay; setOverlay(v); onShowOverlay(v); }

  const activeColor = TAB_COLORS.find(c => c.id === color) ?? TAB_COLORS[0];
  const styleNames: Record<string, string> = { slim: 'Slim', large: 'Large', floating: 'Floating' };

  // Reusable dropdown component
  function Dropdown({ open, onToggle, label, items, onPick, selected }: {
    open: boolean;
    onToggle: () => void;
    label: string;
    items: { id: string; label: string }[];
    onPick: (id: string) => void;
    selected: string;
  }) {
    return (
      <div style={{ position: 'relative' }}>
        <button onClick={onToggle} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'rgba(255,255,255,0.07)',
          cursor: 'pointer', color: '#fff',
          fontSize: 12, minWidth: 110,
          justifyContent: 'space-between',
        }}>
          <span>{label}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <polyline
              points={open ? '1,7 5,3 9,7' : '1,3 5,7 9,3'}
              stroke="rgba(255,255,255,0.5)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {open && (
          <>
            <div onClick={onToggle} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
            <div style={{
              position: 'absolute', right: 0, top: '110%', zIndex: 9999,
              background: '#2a3547',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8, overflow: 'hidden', minWidth: 120,
            }}>
              {items.map(item => (
                <button
                  key={item.id}
                  onClick={() => onPick(item.id)}
                  style={{
                    display: 'block', width: '100%',
                    padding: '9px 14px', border: 'none',
                    background: item.id === selected ? 'rgba(255,255,255,0.12)' : 'transparent',
                    color: item.id === selected ? '#fff' : 'rgba(255,255,255,0.7)',
                    fontSize: 12, cursor: 'pointer',
                    textAlign: 'left',
                    fontWeight: item.id === selected ? 700 : 400,
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // Reusable settings row
  function Row({ title, desc, control, first }: { title: string; desc: string; control: any; first?: boolean }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 0',
        borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.06)',
      }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: 500 }}>{title}</div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 3 }}>{desc}</div>
        </div>
        {control}
      </div>
    );
  }

  const toggleBtn = (
    <button onClick={flipOverlay} style={{
      width: 44, height: 24, borderRadius: 12,
      border: 'none', cursor: 'pointer', flexShrink: 0,
      background: overlay ? 'linear-gradient(135deg,#55cc55,#2a8a2a)' : 'rgba(255,255,255,0.15)',
      position: 'relative', transition: 'background 0.2s',
    }}>
      <span style={{
        position: 'absolute', top: 4,
        width: 16, height: 16, borderRadius: '50%',
        background: 'white', transition: 'left 0.2s',
        left: overlay ? 24 : 4,
      }} />
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Row title="Background Overlay" desc="Dim the screen when panel is open" control={toggleBtn} first />
      <Row title="Action" desc="What to do when downloads finish" control={
        <Dropdown open={ddAction} onToggle={() => setDdAction(o => !o)}
          label={action === 'shutdown' ? 'Shutdown' : 'Sleep'}
          items={[{ id: 'shutdown', label: 'Shutdown' }, { id: 'sleep', label: 'Sleep' }]}
          onPick={pickAction} selected={action}
        />
      } />
      <Row title="Button Color" desc="Color of the side tab button" control={
        <Dropdown open={ddColor} onToggle={() => setDdColor(o => !o)}
          label={activeColor.label} items={TAB_COLORS}
          onPick={pickColor} selected={color}
        />
      } />
      <Row title="Button Style" desc="Shape of the side tab button" control={
        <Dropdown open={ddStyle} onToggle={() => setDdStyle(o => !o)}
          label={styleNames[style]}
          items={[{ id: 'slim', label: 'Slim' }, { id: 'large', label: 'Large' }, { id: 'floating', label: 'Floating' }]}
          onPick={pickStyle} selected={style}
        />
      } />
      <Row title="Panel Side" desc="Side the panel slides out from" control={
        <Dropdown open={ddSide} onToggle={() => setDdSide(o => !o)}
          label={side === 'left' ? 'Left' : 'Right'}
          items={[{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }]}
          onPick={pickSide} selected={side}
        />
      } />
    </div>
  );
};
