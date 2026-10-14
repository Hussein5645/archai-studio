/**
 * "Link to an ArchAI project" (Live Bridge): a plugin's Link to project button asks ArchAI, which
 * shows this dialog; the choice (an existing project, or a new one) goes back to the plugin
 * (src/live/board.ts, request `bind` with `choose`). One picker for every app.
 */
import { useState, useSyncExternalStore } from 'react';
import { useApp, useCloudProjects } from '@/app/context';
import styles from '@/ui/AccountDialog.module.css';
import own from './LiveBridgePanel.module.css';

export type ProjectChoice = { project: string } | { newName: string } | null;

interface Request {
  app: string;
  name: string;
  resolve: (choice: ProjectChoice) => void;
}

let current: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Shows the picker for a plugin; resolves with the user's choice (null: cancelled). */
export function chooseProject(app: string, name: string): Promise<ProjectChoice> {
  current?.resolve(null);
  return new Promise((resolve) => {
    current = {
      app,
      name,
      resolve: (choice) => {
        current = null;
        emit();
        resolve(choice);
      },
    };
    emit();
  });
}

export function ProjectPicker() {
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  return request ? <Picker key={`${request.app}:${request.name}`} request={request} /> : null;
}

function Picker({ request }: { request: Request }) {
  const { persistence } = useApp();
  const [newName, setNewName] = useState(request.name);
  const online = useCloudProjects();
  const recent = useSyncExternalStore((listener) => persistence.subscribe(listener), () => persistence.recent());
  const projects = [...recent, ...online.projects.filter((project) => !recent.some((entry) => entry.id === project.id)).map((project) => ({ ...project, cloud: true }))];
  return (
    <div className={styles.backdrop} role="presentation">
      <div className={styles.dialog} role="dialog" aria-label="Link to an ArchAI project" data-testid="bridge-project-picker">
        <div className={styles.header}>
          <h2 className={styles.title}>Link {request.app} to a project</h2>
        </div>
        <div className={own.picker}>
          <p>
            {request.app} ({request.name || 'model'}) will sync with the project you choose. The link is remembered, and syncing continues when you open another project.
          </p>
          <ul>
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => request.resolve({ project: p.id })}>
                  <strong>{p.name || 'Untitled'}</strong>
                  <small>{p.cloud ? 'Online · ' : ''}{new Date(p.updatedAt).toLocaleDateString()}</small>
                </button>
              </li>
            ))}
          </ul>
          <form
            className={own.newProject}
            onSubmit={(e) => {
              e.preventDefault();
              request.resolve({ newName: newName.trim() || request.name || 'Live Bridge project' });
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New project name" placeholder="New project name" />
            <button type="submit">New project</button>
          </form>
          <div className={own.actions}>
            <button type="button" onClick={() => request.resolve(null)}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
