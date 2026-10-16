import { Button, Modal } from '@/components';
import { closeModal } from '@/state/ui';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export const ConfirmModal = ({ title, message, confirmLabel = 'Confirm', danger, onConfirm }: ConfirmModalProps) => (
  <Modal
    title={title}
    onClose={closeModal}
    size="sm"
    footer={
      <>
        <Button variant="secondary" onClick={closeModal}>
          Cancel
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          onClick={() => {
            closeModal();
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </>
    }
  >
    <p className="text-sm text-text">{message}</p>
  </Modal>
);
