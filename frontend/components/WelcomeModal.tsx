/// <reference types="react" />

// Shows a one-time welcome message when the plugin is first installed
export const WelcomeModal = ({ welcomed, onDismiss }: { welcomed: boolean; onDismiss: () => void }) => {
  const react = (window as any).SP_REACT as typeof import('react');
  const [show, setShow] = react.useState(!welcomed);

  if (!show) return null;

  function close() {
    setShow(false);
    onDismiss();
  }

  const overlayStyle = {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 9998,
    background: 'rgba(0,0,0,0.7)',
  };

  const modalStyle = {
    position: 'fixed' as const,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    zIndex: 9999,
    width: 360,
    background: '#0d0d0d',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 14,
    overflow: 'hidden',
  };

  return (
    <>
      <div style={overlayStyle} />
      <div style={modalStyle}>

        <div style={{ padding: '20px 22px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🖥️</div>
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
            Welcome to Auto Shutdown!
          </div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, lineHeight: 1.6 }}>
            ⚠️{' '}
            <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Heads up!</strong>
            {' '}Don't forget to{' '}
            <strong style={{ color: 'rgba(255,255,255,0.8)' }}>disable</strong>
            {' '}the auto shutdown feature when you don't need it — if a small game update
            downloads automatically, your PC will shut down after the set delay.
          </div>
        </div>

        <div style={{
          padding: '14px 22px',
          margin: '16px 22px 0',
          background: 'rgba(255,255,255,0.04)',
          borderRadius: 8,
        }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: 600, letterSpacing: 1, marginBottom: 6 }}>
            WHERE TO FIND SETTINGS
          </div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, lineHeight: 1.7 }}>
            Steam menu →{' '}
            <strong style={{ color: '#fff' }}>Millennium Library Manager</strong>
            {' '}→{' '}
            <strong style={{ color: '#fff' }}>Auto Shutdown</strong>
          </div>
        </div>

        <div style={{ padding: '16px 22px 20px', textAlign: 'center' }}>
          <button
            onClick={close}
            style={{
              width: '100%',
              padding: '10px 0',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.12)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Got it! 👍
          </button>
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, marginTop: 12 }}>
            Made with 💖 by BambooFury
          </div>
        </div>

      </div>
    </>
  );
};
