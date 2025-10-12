import { Injectable } from '@angular/core';

/**
 * Avatar Service
 * Generates consistent avatars for users across the entire application
 * Uses DiceBear API v7 with cached style mapping per user
 */
@Injectable({
  providedIn: 'root'
})
export class AvatarService {
  // Cache to store username -> style mapping for consistency
  private avatarStyleCache = new Map<string, string>();
  
  // Available DiceBear avatar styles
  private readonly styles = [
    'adventurer',
    'avataaars', 
    'bottts',
    'fun-emoji',
    'pixel-art',
    'thumbs'
  ];

  constructor() {
    // Try to load cache from localStorage
    this.loadCacheFromStorage();
  }

  /**
   * Get avatar URL for a username with consistent style
   * @param username - The username to generate avatar for
   * @param size - Size of the avatar in pixels (default: 40)
   * @returns DiceBear API URL for the avatar
   */
  getAvatarUrl(username: string, size: number = 40): string {
    const seed = encodeURIComponent(username);
    const style = this.getOrCreateStyle(username);
    
    return `https://api.dicebear.com/7.x/${style}/svg?seed=${seed}&size=${size}`;
  }

  /**
   * Get or create a consistent style for a username
   * Once assigned, the style is cached and will always be the same
   */
  private getOrCreateStyle(username: string): string {
    // Check cache first
    if (this.avatarStyleCache.has(username)) {
      return this.avatarStyleCache.get(username)!;
    }

    // Generate new style based on username hash
    const style = this.generateStyleFromUsername(username);
    
    // Cache it
    this.avatarStyleCache.set(username, style);
    this.saveCacheToStorage();
    
    return style;
  }

  /**
   * Generate a consistent style from username using hash
   */
  private generateStyleFromUsername(username: string): string {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    return this.styles[Math.abs(hash) % this.styles.length];
  }

  /**
   * Load cache from localStorage for persistence
   */
  private loadCacheFromStorage(): void {
    try {
      const cached = localStorage.getItem('avatar_style_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        this.avatarStyleCache = new Map(Object.entries(parsed));
      }
    } catch (error) {
      console.warn('Failed to load avatar cache:', error);
    }
  }

  /**
   * Save cache to localStorage
   */
  private saveCacheToStorage(): void {
    try {
      const cacheObj = Object.fromEntries(this.avatarStyleCache);
      localStorage.setItem('avatar_style_cache', JSON.stringify(cacheObj));
    } catch (error) {
      console.warn('Failed to save avatar cache:', error);
    }
  }

  /**
   * Clear the avatar cache (useful for testing)
   */
  clearCache(): void {
    this.avatarStyleCache.clear();
    localStorage.removeItem('avatar_style_cache');
  }
}
