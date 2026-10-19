import * as React from "react";
import { createRoot } from "react-dom/client";
import { FileViewer } from "@file-viewer/react";
import { officeRenderers } from "@file-viewer/preset-office";

const status = document.getElementById("status");
const log = (text) => {
  status.textContent = `${status.textContent}\n${text}`.trim();
};

function App() {
  const [file, setFile] = React.useState(null);
  return (
    <div>
      <input
        type="file"
        onChange={(event) => {
          const picked = event.target.files?.[0] ?? null;
          setFile(picked);
          log(`picked: ${picked ? picked.name : "none"}`);
        }}
      />
      <div style={{ height: 520, marginTop: 8, border: "1px solid #444" }}>
        {file !== null && (
          <FileViewer
            file={file}
            preset={officeRenderers}
            onEvent={(event) => log(`event: ${event?.type ?? JSON.stringify(event).slice(0, 120)}`)}
            onError={(error) => log(`error: ${error?.message ?? String(error)}`)}
          />
        )}
      </div>
    </div>
  );
}

window.addEventListener("error", (event) => log(`window.error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => log(`unhandled: ${event.reason?.message ?? String(event.reason)}`));

createRoot(document.getElementById("app")).render(<App />);
