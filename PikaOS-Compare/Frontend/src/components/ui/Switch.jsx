/** Switch — 42×24 pill; knob springs across and stretches while held. */
export default function Switch({ checked, onChange, label, disabled = false, ...rest }) {
  return (
    <label className="pk-switch">
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.checked)}
        {...rest}
      />
      <span className="track" />
      {label}
    </label>
  );
}
