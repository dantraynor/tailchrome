/**
 * Reusable toggle switch component.
 * Renders a custom CSS toggle with smooth transitions.
 */
export function createToggle(
  checked: boolean,
  onChange: (checked: boolean) => void,
  disabled = false,
): HTMLElement {
  const label = document.createElement("label");
  label.className = "toggle-switch" + (disabled ? " disabled" : "");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = disabled;

  const track = document.createElement("span");
  track.className = "toggle-track";

  const knob = document.createElement("span");
  knob.className = "toggle-knob";

  input.addEventListener("change", () => {
    if (!disabled) {
      onChange(input.checked);
    }
  });

  label.appendChild(input);
  label.appendChild(track);
  label.appendChild(knob);

  return label;
}
