import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { Store } from '@ngrx/store';
import { map, filter, take, timeout, catchError } from 'rxjs/operators';
import { combineLatest, of } from 'rxjs';
import { selectIsAuthenticated, selectAuthLoading } from '../../store/auth/auth.selectors';

/**
 * Guest Guard - Prevents authenticated users from accessing auth pages (login/register)
 * Redirects authenticated users to the main application
 * Waits for session to load before checking authentication
 */
export const guestGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  // Wait for auth loading to complete, then check authentication
  return combineLatest([
    store.select(selectAuthLoading),
    store.select(selectIsAuthenticated)
  ]).pipe(
    filter(([loading]) => !loading), // Wait until session check completes
    take(1),
    timeout(3000), // Don't wait forever (3 seconds max)
    catchError(() => of([false, false] as [boolean, boolean])), // On timeout, assume not authenticated
    map(([_, isAuthenticated]) => {
      if (isAuthenticated) {
        console.log('[GuestGuard] User authenticated, redirecting to main app');
        router.navigate(['/']);
        return false;
      }
      return true;
    })
  );
};
