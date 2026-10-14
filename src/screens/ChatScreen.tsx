import React, { useState } from 'react';
import { Send, Smile, Paperclip, Heart, Sparkles } from 'lucide-react';
import { nookiTokens } from '../tokens/designTokens';
import { PillButton } from '../components/common/PillButton';
import { StoryBadge } from '../components/common/StoryBadge';

export const ChatScreen: React.FC = () => {
  const [messages, setMessages] = useState([
    {
      id: 1,
      sender: 'Chloe',
      text: 'Good morning my favorite Nookie! 🌸 Did you sleep well?',
      time: '8:42 AM',
      isMe: false,
    },
    {
      id: 2,
      sender: 'Milo',
      text: 'Dreamt of you! Woke up wishing our timezones were 0 hours instead of 7 🥺',
      time: '8:45 AM',
      isMe: true,
    },
    {
      id: 3,
      sender: 'Chloe',
      text: 'I just sent you a Nook! Tap the heart when you feel it tap tap 💕',
      time: '8:46 AM',
      isMe: false,
      nookType: 'Heartbeat Nook',
    },
  ]);

  const [inputVal, setInputVal] = useState('');

  const handleSend = () => {
    if (!inputVal.trim()) return;
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        sender: 'Milo',
        text: inputVal,
        time: 'Just now',
        isMe: true,
      },
    ]);
    setInputVal('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', paddingBottom: '90px' }}>
      {/* Partner header status bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          backgroundColor: nookiTokens.colors.bgSurface,
          borderRadius: nookiTokens.radii.lg,
          border: `1px solid ${nookiTokens.colors.borderSubtle}`,
          boxShadow: nookiTokens.shadows.subtle,
          marginBottom: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              backgroundColor: nookiTokens.colors.peachSoft,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.2rem',
              border: `2px solid ${nookiTokens.colors.peachPrimary}`,
            }}
          >
            🧸
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontWeight: 800, fontSize: '0.92rem', color: nookiTokens.colors.textPrimary }}>
                Chloe
              </span>
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: nookiTokens.colors.greenPrimary,
                }}
              />
            </div>
            <span style={{ fontSize: '0.74rem', color: nookiTokens.colors.textMuted }}>
              Listening to cozy rain · 3:45 PM in London
            </span>
          </div>
        </div>

        <PillButton variant="peach" size="sm" icon={<Heart size={13} fill="#FFF" />}>
          Nook Her
        </PillButton>
      </div>

      {/* Message stream */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          overflowY: 'auto',
          padding: '4px 2px',
        }}
      >
        {/* Storybook Date separator */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
          <StoryBadge label="Today · Connected in Our Nook" variant="sage" />
        </div>

        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.isMe ? 'flex-end' : 'flex-start',
              maxWidth: '82%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: m.isMe ? 'flex-end' : 'flex-start',
            }}
          >
            {m.nookType && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  color: nookiTokens.colors.peachDeep,
                  marginBottom: '4px',
                  background: nookiTokens.colors.peachSurface,
                  padding: '2px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${nookiTokens.colors.peachSoft}`,
                }}
              >
                <Sparkles size={11} />
                <span>Special Nook: {m.nookType}</span>
              </div>
            )}

            <div
              style={{
                backgroundColor: m.isMe
                  ? nookiTokens.colors.peachPrimary
                  : nookiTokens.colors.bgSurface,
                color: m.isMe ? '#FFFDF9' : nookiTokens.colors.textPrimary,
                borderRadius: m.isMe ? '22px 22px 6px 22px' : '22px 22px 22px 6px',
                padding: '12px 16px',
                boxShadow: m.isMe ? nookiTokens.shadows.glowPeach : nookiTokens.shadows.subtle,
                border: m.isMe ? 'none' : `1px solid ${nookiTokens.colors.borderSubtle}`,
                fontSize: '0.9rem',
                lineHeight: 1.45,
              }}
            >
              {m.text}
            </div>

            <span
              style={{
                fontSize: '0.68rem',
                color: nookiTokens.colors.textMuted,
                marginTop: '4px',
                padding: '0 4px',
              }}
            >
              {m.time}
            </span>
          </div>
        ))}
      </div>

      {/* Input row */}
      <div
        style={{
          marginTop: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          backgroundColor: nookiTokens.colors.bgSurface,
          padding: '6px 8px 6px 14px',
          borderRadius: nookiTokens.radii.pill,
          border: `1px solid ${nookiTokens.colors.borderSubtle}`,
          boxShadow: nookiTokens.shadows.subtle,
        }}
      >
        <button
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: nookiTokens.colors.textMuted }}
        >
          <Smile size={20} />
        </button>

        <input
          type="text"
          placeholder="Whisper a Nook to Chloe..."
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontSize: '0.9rem',
            fontFamily: nookiTokens.typography.fontFamily,
            color: nookiTokens.colors.textPrimary,
          }}
        />

        <button
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: nookiTokens.colors.textMuted }}
        >
          <Paperclip size={18} />
        </button>

        <button
          onClick={handleSend}
          style={{
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            backgroundColor: nookiTokens.colors.peachPrimary,
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#FFF',
            boxShadow: nookiTokens.shadows.glowPeach,
          }}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};
