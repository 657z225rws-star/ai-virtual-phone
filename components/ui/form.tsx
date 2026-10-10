"use client";

import { useState } from "react";
import type { CSSProperties, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

/* ── Input ── */
type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
};

export function Input({ className, ...rest }: InputProps) {
  return <input className={`ui-input ${className ?? ""}`} {...rest} />;
}

/* ── SecretInput（密钥/Token 输入框）──
 * 默认明文显示，右侧小眼睛点击后切换为圆点隐藏。
 * 之前所有密钥框都用 type="password"，浏览器对密码框有铁律：
 * 中文输入法被锁死、剪贴板面板禁用、粘贴后只见圆点，极难核对。
 */
type SecretInputProps = InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
  wrapperClassName?: string;
  wrapperStyle?: CSSProperties;
};

export function SecretInput({ className = "ui-input", wrapperClassName, wrapperStyle, disabled, ...rest }: SecretInputProps) {
  const [hidden, setHidden] = useState(false);
  return (
    <div className={`flex min-w-0 items-center gap-2 ${wrapperClassName ?? ""}`} style={wrapperStyle}>
      <input
        type={hidden ? "password" : "text"}
        className={`${className} min-w-0 flex-1`}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setHidden(v => !v)}
        title={hidden ? "显示内容" : "隐藏内容"}
        aria-label={hidden ? "显示内容" : "隐藏内容"}
        disabled={disabled}
        className="ui-btn ui-btn-soft-action shrink-0 !px-2.5"
        style={{ height: 36, width: 36, padding: 0 }}
      >
        {hidden ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>
    </div>
  );
}

/* ── Textarea ── */
type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
};

export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={`ui-textarea ${className ?? ""}`} {...rest} />;
}

/* ── Select ── */
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  className?: string;
  children: ReactNode;
};

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={`ui-select ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
}

/* ── Toggle ── */
export function Toggle({
  checked,
  onChange,
  className,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`ui-toggle ${className ?? ""}`}
      data-ui="toggle"
      data-checked={checked ? "" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-knob" />
    </button>
  );
}

/* ── Slider (param row with label + value display) ── */
export function Slider({
  label,
  value,
  displayValue,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  displayValue?: string;
  hint?: string;
}) {
  return (
    <div className={`ui-slider-row ${className ?? ""}`}>
      <span className="ui-slider-label">{label}</span>
      <input type="range" className="ui-slider" data-ui="slider" value={value} {...rest} />
      {displayValue !== undefined && <span className="ui-slider-value">{displayValue}</span>}
      {hint && <span className="ui-slider-hint">{hint}</span>}
    </div>
  );
}

/* ── Avatar Upload ── */
export function AvatarUpload({
  src,
  onClick,
  className,
}: {
  src?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" className={`ui-avatar-upload ${className ?? ""}`} onClick={onClick}>
      {src ? (
        <img src={src} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />
      ) : (
        <span className="ui-avatar-upload-placeholder">+</span>
      )}
      <span className="ui-avatar-upload-overlay">更换</span>
    </button>
  );
}

/* ── Color Input ── */
export function ColorInput({
  value,
  onChange,
  label,
  className,
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
  className?: string;
}) {
  return (
    <label className={`ui-color-input ${className ?? ""}`}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {label && <span>{label}</span>}
    </label>
  );
}
