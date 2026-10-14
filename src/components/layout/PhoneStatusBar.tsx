import React from 'react';
import { Wifi, BatteryMedium, Signal } from 'lucide-react';
import { nookiTokens } from '../../tokens/designTokens';

export const PhoneStatusBar: React.FC = () => {
  return (
    <div
      style={{
        height: '44px',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        color: nookiTokens.colors.textSecondary,
        fontSize: '0.85rem',
        fontWeight: 700,
        zIndex: 50,
        userSelect: 'none',
      }}
    >
      <span>9:41</span>
      {/* Dynamic island / speaker notch pill */}
      <div
        style={{
          width: '94px',
          height: '24px',
          backgroundColor: '#302521',
          borderRadius: '20px',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Signal size={14} strokeWidth={2.4} />
        <Wifi size={14} strokeWidth={2.4} />
        <BatteryMedium size={18} strokeWidth={2.2} />
      </div>
    </div>
  );
};
