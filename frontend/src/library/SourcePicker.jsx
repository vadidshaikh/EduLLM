import Loading from "../ui/Loading";

/**
 * Checkboxes for choosing source docs, grouped into this workspace's and
 * the institute library's. `docs` is null while loading. With `cite`, a
 * picked doc shows the number it's cited as. `empty` replaces the message
 * shown when there are no docs.
 */
export default function SourcePicker({ docs, picked, onChange, max, disabled, cite = false, empty }) {
  if (docs === null) return <Loading label="Loading docs" compact />;
  if (docs.length === 0) {
    return (
      <p className="note-box">
        {empty ?? "There are no ready docs here or in the institute library yet. Upload some in the Docs tab first."}
      </p>
    );
  }
  const groups = [
    ["This workspace", docs.filter((d) => d.workspace_id)],
    ["Institute library", docs.filter((d) => !d.workspace_id)],
  ];
  return (
    <div className="source-pick">
      {groups.map(
        ([heading, rows]) =>
          rows.length > 0 && (
            <div key={heading}>
              <h4>{heading}</h4>
              <div className="publish">
                {rows.map((d) => {
                  const checked = picked.includes(d.id);
                  return (
                    <label key={d.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || (!checked && picked.length >= max)}
                        onChange={(e) => onChange(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))}
                      />
                      <span>
                        <b>{d.title}</b>
                        {cite && checked && <small>Cited as [{picked.indexOf(d.id) + 1}]</small>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )
      )}
    </div>
  );
}
