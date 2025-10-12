import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { Store } from '@ngrx/store';
import { map, take } from 'rxjs/operators';
import { selectIsAuthenticated } from '../../store/auth/auth.selectors';

/**
 * Guest Guard - Prevents authenticated users from accessing auth pages (login/register)
 * Redirects authenticated users to the main application
 */
export const guestGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  return store.select(selectIsAuthenticated).pipe(
    take(1),
    map(isAuthenticated => {
      if (isAuthenticated) {
        console.log('[GuestGuard] User authenticated, redirecting to main app');
        router.navigate(['/']);
        return false;
      }
      return true;
    })
  );
};
