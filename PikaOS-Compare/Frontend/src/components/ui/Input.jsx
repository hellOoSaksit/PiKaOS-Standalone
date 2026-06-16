/**
 * Field — labelled text input with PiKaOs focus ring + error state.
 * error: string shows crimson ring + message below.
 */
export default function Field({ label, error, id, className = '', ...rest }) {
  return (
    <div className={'bf' + (error ? ' has-error' : '') + (className ? ' ' + className : '')}>
      {label && <label className="bf-label" htmlFor={id}>{label}</label>}
      <input className="bf-input" id={id} {...rest} />
      {error && <span className="bf-error">{error}</span>}
    </div>
  );
}
