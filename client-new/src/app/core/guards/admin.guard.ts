import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { Store } from '@ngrx/store';
import { map, take } from 'rxjs/operators';
import { selectUser } from '../../store/auth/auth.selectors';
import { hasRole } from '../utils/permissions';

export const adminGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  return store.select(selectUser).pipe(
    take(1),
    map(user => {
      if (!user || !hasRole(user, ['superuser', 'admin'])) {
        router.navigate(['/']);
        return false;
      }
      return true;
    })
  );
};
