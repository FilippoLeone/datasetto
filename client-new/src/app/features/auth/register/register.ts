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
  selector: 'app-register',
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './register.html',
  styleUrl: './register.css'
})
export class Register implements OnInit {
  username = '';
  password = '';
  confirmPassword = '';
  displayName = '';
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
          console.log('[Register] User already authenticated, redirecting to main app');
          this.router.navigate(['/']);
        }
      });
  }

  get passwordsMatch(): boolean {
    return this.password === this.confirmPassword;
  }

  get isValid(): boolean {
    return !!(this.username && this.password && this.confirmPassword && 
              this.displayName && this.passwordsMatch);
  }

  onSubmit(): void {
    if (this.isValid) {
      this.store.dispatch(AuthActions.register({
        username: this.username,
        password: this.password,
        displayName: this.displayName
      }));
    }
  }
}
