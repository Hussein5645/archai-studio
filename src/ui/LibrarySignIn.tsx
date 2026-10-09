/** Shown in the library panels while signed out: the cloud libraries need an ArchAI account. */
import { LogIn } from 'lucide-react';
import { openAccountDialog } from './account-dialog';
import { useI18n } from './i18n';
import { TextButton } from './primitives';

export function LibrarySignIn({ className, what }: { className?: string; what: string }) {
  const { t } = useI18n();
  return (
    <div className={className} data-testid="library-sign-in">
      {t(`Sign in to use the ArchAI ${what} library. Your own imports work without an account.`)}
      <div style={{ marginTop: 8 }}>
        <TextButton primary onClick={() => openAccountDialog('sign-in', `Sign in to use the ArchAI ${what} library.`)}>
          <LogIn size={14} /> {t('Sign in')}
        </TextButton>
      </div>
    </div>
  );
}
