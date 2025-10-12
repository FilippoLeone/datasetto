import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { of } from 'rxjs';
import { map, catchError, switchMap, tap } from 'rxjs/operators';
import * as AuthActions from './auth.actions';
import { SocketService } from '../../core/services';
import { Router } from '@angular/router';

@Injectable()
export class AuthEffects {
  private actions$ = inject(Actions);
  private socketService = inject(SocketService);
  private router = inject(Router);

  login$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.login),
      switchMap(({ username, password }) =>
        this.socketService.login(username, password).pipe(
          map(({ user, account, session }) =>
            AuthActions.loginSuccess({ user, account, session })
          ),
          catchError((error) =>
            of(AuthActions.loginFailure({ error: error.message || 'Login failed' }))
          )
        )
      )
    )
  );

  register$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.register),
      switchMap(({ username, password, displayName }) =>
        this.socketService.register(username, password, displayName).pipe(
          map(({ user, account, session }) =>
            AuthActions.registerSuccess({ user, account, session })
          ),
          catchError((error) =>
            of(AuthActions.registerFailure({ error: error.message || 'Registration failed' }))
          )
        )
      )
    )
  );

  loginSuccess$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActions.loginSuccess, AuthActions.registerSuccess),
        tap(({ session }) => {
          // Store session in localStorage
          localStorage.setItem('session', JSON.stringify(session));
          // Navigate to main app
          this.router.navigate(['/']);
        })
      ),
    { dispatch: false }
  );

  logout$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.logout),
      switchMap(() =>
        this.socketService.logout().pipe(
          map(() => AuthActions.logoutSuccess()),
          catchError(() => of(AuthActions.logoutSuccess()))
        )
      )
    )
  );

  logoutSuccess$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActions.logoutSuccess),
        tap(() => {
          // Clear session from localStorage
          localStorage.removeItem('session');
          // Navigate to login
          this.router.navigate(['/auth/login']);
        })
      ),
    { dispatch: false }
  );

  loadSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.loadSession),
      switchMap(() => {
        const sessionData = localStorage.getItem('session');
        if (!sessionData) {
          return of(AuthActions.sessionInvalid());
        }

        try {
          const session = JSON.parse(sessionData);
          return this.socketService.validateSession(session.token).pipe(
            map(({ user, account }) =>
              AuthActions.sessionLoaded({ user, account, session })
            ),
            catchError((error) => {
              // If already authenticated, don't invalidate the session
              if (error.message?.includes('Already authenticated')) {
                console.log('[AuthEffects] Session already validated, keeping existing session');
                // Return a dummy action that doesn't change state
                return of(AuthActions.sessionInvalid());
              }
              return of(AuthActions.sessionInvalid());
            })
          );
        } catch {
          return of(AuthActions.sessionInvalid());
        }
      })
    )
  );

  updateAccount$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.updateAccount),
      switchMap(({ account }) =>
        this.socketService.updateAccount(account).pipe(
          map(({ account: updatedAccount, user }) =>
            AuthActions.updateAccountSuccess({ account: updatedAccount, user })
          ),
          catchError((error) =>
            of(AuthActions.updateAccountFailure({ error: error.message || 'Update failed' }))
          )
        )
      )
    )
  );
}
