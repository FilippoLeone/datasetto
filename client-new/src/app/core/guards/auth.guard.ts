import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { Store } from '@ngrx/store';
import { map, filter, take, timeout, catchError } from 'rxjs/operators';
import { combineLatest, of } from 'rxjs';
import { selectIsAuthenticated, selectAuthLoading } from '../../store/auth/auth.selectors';

/**
 * Auth Guard - Protects routes that require authentication
 * Redirects unauthenticated users to the login page
 * Waits for session to load before checking authentication
 */
export const authGuard: CanActivateFn = () => {
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
      if (!isAuthenticated) {
        console.log('[AuthGuard] User not authenticated, redirecting to login');
        router.navigate(['/auth/login']);
        return false;
      }
      return true;
    })
  );
};
