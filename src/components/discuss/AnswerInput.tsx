import React from 'react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { ANSWER_MAX_LENGTH, SLIDER_MAX, SLIDER_MIN } from '../../lib/questionFormat';
import type { AnswerValue, Question } from '../../types/database';

interface AnswerInputProps {
  question: Question;
  /** The draft answer: '' or 0 or [] until this phone has something worth sending. */
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  disabled?: boolean;
}

const optionStyle = (selected: boolean, disabled: boolean): React.CSSProperties => ({
  width: '100%',
  textAlign: 'left',
  padding: '13px 16px',
  borderRadius: tokens.radii.md,
  border: `1.5px solid ${selected ? tokens.colors.accentSageDeep : tokens.colors.borderSubtle}`,
  backgroundColor: selected ? tokens.colors.accentSageSoft : tokens.colors.bgSurface,
  color: tokens.colors.textPrimary,
  fontSize: '0.88rem',
  fontWeight: selected ? 700 : 600,
  fontFamily: tokens.typography.fontFamily,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  boxShadow: selected ? tokens.shadows.subtle : 'none',
});

const tickStyle = (selected: boolean): React.CSSProperties => ({
  width: '18px',
  height: '18px',
  borderRadius: tokens.radii.full,
  border: `1.5px solid ${selected ? tokens.colors.accentSageDeep : tokens.colors.borderSoft}`,
  backgroundColor: selected ? tokens.colors.accentSageDeep : 'transparent',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const moveButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '32px',
  height: '32px',
  borderRadius: tokens.radii.full,
  border: `1px solid ${tokens.colors.borderSubtle}`,
  backgroundColor: tokens.colors.bgSurface,
  color: disabled ? tokens.colors.textMuted : tokens.colors.accentSageDeep,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
});

/**
 * The four ways a question can be answered: free typing, picking options, ordering them,
 * or a 1-10 scale. One component so every session behaves the same whichever type the
 * imported question turned out to be.
 *
 * Ranking supports real drag and drop on a pointer device, and up/down buttons everywhere
 * else — touch browsers do not implement HTML5 drag events, and the buttons are what a
 * screen reader can use.
 */
export const AnswerInput: React.FC<AnswerInputProps> = ({ question, value, onChange, disabled }) => {
  const options = question.options ?? [];

  if (question.input_type === 'text') {
    const text = typeof value === 'string' ? value : '';
    return (
      <div data-answer-input="text">
        <textarea
          aria-label="Your answer"
          value={text}
          disabled={disabled}
          placeholder="Write it however you like…"
          onChange={(event) => onChange(event.target.value.slice(0, ANSWER_MAX_LENGTH))}
          rows={4}
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: tokens.radii.md,
            border: `1.5px solid ${tokens.colors.borderSubtle}`,
            backgroundColor: tokens.colors.bgSurface,
            fontSize: '0.9rem',
            fontFamily: tokens.typography.fontFamily,
            color: tokens.colors.textPrimary,
            resize: 'vertical',
            outline: 'none',
            lineHeight: 1.5,
          }}
        />
        <span style={{ display: 'block', textAlign: 'right', fontSize: '0.68rem', color: tokens.colors.textMuted }}>
          {`${text.length}/${ANSWER_MAX_LENGTH}`}
        </span>
      </div>
    );
  }

  if (question.input_type === 'slider') {
    const number = typeof value === 'number' ? value : 0;
    const picked = number >= SLIDER_MIN;
    return (
      <div data-answer-input="slider" style={{ padding: '4px 2px 0 2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: '6px' }}>
          <span
            data-slider-value
            style={{
              fontSize: '2.4rem',
              fontWeight: 800,
              lineHeight: 1,
              color: picked ? tokens.colors.accentSageDeep : tokens.colors.textMuted,
            }}
          >
            {picked ? number : '–'}
          </span>
          <span style={{ fontSize: '0.8rem', color: tokens.colors.textMuted, fontWeight: 700 }}>
            {`/ ${SLIDER_MAX}`}
          </span>
        </div>
        <input
          type="range"
          aria-label={`Your answer from ${SLIDER_MIN} to ${SLIDER_MAX}`}
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={1}
          value={picked ? number : Math.round((SLIDER_MIN + SLIDER_MAX) / 2)}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          style={{ width: '100%', accentColor: tokens.colors.accentSageDeep, marginTop: '10px' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: tokens.colors.textMuted }}>
          <span>{SLIDER_MIN}</span>
          <span>{picked ? '' : 'Slide to pick a number'}</span>
          <span>{SLIDER_MAX}</span>
        </div>
      </div>
    );
  }

  if (question.input_type === 'ranking') {
    // The draft starts in the library's order; dragging or tapping an arrow reorders it.
    const order = Array.isArray(value) && value.length ? value.map(String) : options;
    const move = (from: number, to: number) => {
      if (to < 0 || to >= order.length) return;
      const next = [...order];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      onChange(next);
    };
    return (
      <div data-answer-input="ranking">
        <p style={{ fontSize: '0.74rem', color: tokens.colors.textSecondary, margin: '0 0 8px 0' }}>
          Drag them into your order, or use the arrows.
        </p>
        <ol
          role="list"
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}
        >
          {order.map((label, index) => (
            <li
              key={label}
              data-ranking-item={label}
              data-rank={index + 1}
              draggable={!disabled}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
              }}
              onDragOver={(event) => {
                if (disabled) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                if (disabled) return;
                event.preventDefault();
                const from = Number(event.dataTransfer.getData('text/plain'));
                if (Number.isInteger(from) && from !== index) move(from, index);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: tokens.radii.md,
                border: `1.5px solid ${tokens.colors.borderSubtle}`,
                backgroundColor: tokens.colors.bgSurface,
                cursor: disabled ? 'default' : 'grab',
              }}
            >
              <GripVertical size={16} color={tokens.colors.textMuted} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  width: '22px',
                  height: '22px',
                  borderRadius: tokens.radii.full,
                  backgroundColor: tokens.colors.accentSageSoft,
                  color: tokens.colors.accentSageDeep,
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </span>
              <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 600, color: tokens.colors.textPrimary }}>
                {label}
              </span>
              <button
                type="button"
                aria-label={`Move ${label} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, index - 1)}
                style={moveButtonStyle(disabled || index === 0)}
              >
                <ChevronUp size={16} />
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                disabled={disabled || index === order.length - 1}
                onClick={() => move(index, index + 1)}
                style={moveButtonStyle(disabled || index === order.length - 1)}
              >
                <ChevronDown size={16} />
              </button>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // choice and multi_choice share one list of options; only the selection rule differs.
  const multiple = question.input_type === 'multi_choice';
  const selected = multiple
    ? (Array.isArray(value) ? value.map(String) : [])
    : [typeof value === 'string' && value ? value : ''];

  const toggle = (label: string) => {
    if (multiple) {
      const next = selected.includes(label)
        ? selected.filter((item) => item !== label)
        : [...selected, label];
      // Keep the ticked order, so a ranking-style list reads the way it was chosen.
      onChange(options.filter((option) => next.includes(option)));
      return;
    }
    onChange(label);
  };

  return (
    <div
      data-answer-input={multiple ? 'multi_choice' : 'choice'}
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={multiple ? 'Tick every option that applies' : 'Pick one option'}
      style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      {options.map((label) => {
        const isSelected = selected.includes(label);
        return (
          <button
            key={label}
            type="button"
            role={multiple ? undefined : 'radio'}
            aria-checked={multiple ? undefined : isSelected}
            aria-pressed={multiple ? isSelected : undefined}
            aria-label={label}
            data-option={label}
            data-selected={isSelected ? 'true' : 'false'}
            disabled={disabled}
            onClick={() => toggle(label)}
            style={optionStyle(isSelected, Boolean(disabled))}
          >
            <span
              aria-hidden="true"
              style={{
                ...tickStyle(isSelected),
                borderRadius: multiple ? '6px' : tokens.radii.full,
              }}
            />
            <span>{label}</span>
          </button>
        );
      })}
      {multiple && (
        <span style={{ fontSize: '0.7rem', color: tokens.colors.textMuted }}>
          {`${selected.length} selected`}
        </span>
      )}
    </div>
  );
};

export default AnswerInput;
