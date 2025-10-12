import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { of } from 'rxjs';
import { map, catchError, switchMap, tap, mergeMap } from 'rxjs/operators';
import * as AuthActions from './auth.actions';
import * as ChannelActions from '../channel/channel.actions';
import { SocketService } from '../../core/services';
import { Router } from '@angular/router';

@Injectable()
export class AuthEffects {
  private actions$ = inject(Actions);
  private socketService = inject(SocketService);
  private router = inject(Router);
  private store = inject(Store);

  login$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.login),
      switchMap(({ username, password }) =>
        this.socketService.login(username, password).pipe(
          mergeMap(({ user, account, session, channels, groups }) => {
            const actions: any[] = [AuthActions.loginSuccess({ user, account, session })];
            // Dispatch channel data if present
            if (channels && channels.length > 0) {
              actions.push(ChannelActions.loadChannelsSuccess({ channels, groups: groups || [] }));
            }
            return actions;
          }),
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
          mergeMap(({ user, account, session, channels, groups }) => {
            const actions: any[] = [AuthActions.registerSuccess({ user, account, session })];
            // Dispatch channel data if present
            if (channels && channels.length > 0) {
              actions.push(ChannelActions.loadChannelsSuccess({ channels, groups: groups || [] }));
            }
            return actions;
          }),
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

  // Subscribe to socket channel updates
  socketChannelUpdates$ = createEffect(() =>
    this.socketService.onChannelUpdate().pipe(
      map((data) => {
        // Handle both formats: Channel[] or { channels: Channel[]; groups?: ChannelGroup[] }
        if (Array.isArray(data)) {
          return ChannelActions.loadChannelsSuccess({ channels: data, groups: [] });
        } else {
          return ChannelActions.loadChannelsSuccess({ channels: data.channels, groups: data.groups || [] });
        }
      })
    )
  );
}
