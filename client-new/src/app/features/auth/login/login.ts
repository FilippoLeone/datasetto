import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngrx/store';
import { Observable } from 'rxjs';
import { take } from 'rxjs/operators';
import * as AuthActions from '../../../store/auth/auth.actions';
import { selectAuthLoading, selectAuthError, selectIsAuthenticated } from '../../../store/auth/auth.selectors';

@Component({
  selector: 'app-login',
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.css'
})
export class Login implements OnInit {
  username = '';
  password = '';
  loading$: Observable<boolean>;
  error$: Observable<string | null>;

  constructor(
    private store: Store,
    private router: Router
  ) {
    this.loading$ = this.store.select(selectAuthLoading);
    this.error$ = this.store.select(selectAuthError);
  }

  ngOnInit(): void {
    // Redirect if already authenticated
    this.store.select(selectIsAuthenticated)
      .pipe(take(1))
      .subscribe(isAuthenticated => {
        if (isAuthenticated) {
          console.log('[Login] User already authenticated, redirecting to main app');
          this.router.navigate(['/']);
        }
      });
  }

  onSubmit(): void {
    if (this.username && this.password) {
      this.store.dispatch(AuthActions.login({
        username: this.username,
        password: this.password
      }));
    }
  }

  goToRegister(): void {
    // Will be handled by router
  }
}
