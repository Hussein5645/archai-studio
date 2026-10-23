import { openAccountDialog } from '@/ui/account-dialog';
import { useAccount, useAppState, useDispatch } from '@/app/context';
import { renderOf } from '@/studio/viewRender';
import { viewSettingsOf } from './useSceneView';
import { VIEW_STYLE_OPTIONS } from './viewAppearance';

export function RenderChoice({ portalId }: { portalId: string }) {
  const signedIn = useAccount().status === 'signed-in';
  const doc = useAppState((s) => s.doc);
  const dispatch = useDispatch();
  const render = renderOf(doc, portalId);
  const view = viewSettingsOf(doc, portalId);
  return (
    <>
      <label>
        Style{' '}
        <select
          aria-label="View style"
          value={view.style ?? doc.workspace.viewStyle}
          onChange={(e) =>
            void dispatch('set-view3d-settings', { id: portalId, style: e.target.value })
          }
        >
          {VIEW_STYLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Render{' '}
        <select
          aria-label="View renderer"
          value={render.renderer}
          onChange={(e) =>
            e.target.value !== 'default' && !signedIn ? openAccountDialog('sign-in', 'Sign in to download and use Unreal rendering') : void dispatch('set-view3d-settings', { id: portalId, renderer: e.target.value })
          }
        >
          <option value="default">Default</option>
          <option value="unreal">Unreal Engine</option>
          {render.bake?.cacheId && !render.bake.webError && <option value="baked">Baked scene</option>}
        </select>
      </label>
    </>
  );
}
