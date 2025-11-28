import { config } from '@/config';

type SchemaType = 'Organization' | 'WebSite' | 'BreadcrumbList' | 'VideoObject' | 'BroadcastEvent' | 'Person';

interface BreadcrumbItem {
  name: string;
  item: string;
}

export class SEOService {
  private scriptElement: HTMLScriptElement | null = null;
  private siteUrl: string;
  private siteName = 'Datasetto';

  constructor() {
    this.siteUrl = window.location.origin;
    this.initialize();
  }

  private initialize(): void {
    // Find existing script tag or create new one
    this.scriptElement = document.querySelector('script[type="application/ld+json"]');
    
    if (!this.scriptElement) {
      this.scriptElement = document.createElement('script');
      this.scriptElement.type = 'application/ld+json';
      document.head.appendChild(this.scriptElement);
    }

    // Set initial global schema
    this.setGlobalSchema();
  }

  private setGlobalSchema(): void {
    const graph = [
      this.getOrganizationSchema(),
      this.getWebSiteSchema()
    ];
    this.updateSchema(graph);
  }

  private getOrganizationSchema(): Record<string, any> {
    return {
      '@type': 'Organization',
      '@id': `${this.siteUrl}/#organization`,
      'name': this.siteName,
      'url': this.siteUrl,
      'logo': {
        '@type': 'ImageObject',
        'url': `${this.siteUrl}/favicon.svg`
      }
    };
  }

  private getWebSiteSchema(): Record<string, any> {
    return {
      '@type': 'WebSite',
      '@id': `${this.siteUrl}/#website`,
      'url': this.siteUrl,
      'name': this.siteName,
      'publisher': {
        '@id': `${this.siteUrl}/#organization`
      }
    };
  }

  /**
   * Update the JSON-LD script content
   */
  private updateSchema(graph: Record<string, any>[]): void {
    if (!this.scriptElement) return;

    const schema = {
      '@context': 'https://schema.org',
      '@graph': graph
    };

    this.scriptElement.textContent = JSON.stringify(schema, null, 2);
  }

  /**
   * Update breadcrumbs based on current navigation
   */
  updateBreadcrumbs(items: BreadcrumbItem[]): void {
    const breadcrumbList = {
      '@type': 'BreadcrumbList',
      'itemListElement': items.map((item, index) => ({
        '@type': 'ListItem',
        'position': index + 1,
        'name': item.name,
        'item': item.item.startsWith('http') ? item.item : `${this.siteUrl}${item.item}`
      }))
    };

    // Rebuild graph with global schema + new breadcrumbs
    const graph = [
      this.getOrganizationSchema(),
      this.getWebSiteSchema(),
      breadcrumbList
    ];

    this.updateSchema(graph);
  }

  /**
   * Set schema for a channel/stream page
   */
  setChannelSchema(channelName: string, description?: string, isLive = false): void {
    const url = `${this.siteUrl}/channel/${channelName}`;
    
    const breadcrumbs = [
      { name: 'Home', item: '/' },
      { name: 'Channels', item: '/channels' },
      { name: channelName, item: url }
    ];

    const graph: Record<string, any>[] = [
      this.getOrganizationSchema(),
      this.getWebSiteSchema(),
      {
        '@type': 'BreadcrumbList',
        'itemListElement': breadcrumbs.map((item, index) => ({
          '@type': 'ListItem',
          'position': index + 1,
          'name': item.name,
          'item': item.item.startsWith('http') ? item.item : `${this.siteUrl}${item.item}`
        }))
      }
    ];

    if (isLive) {
      graph.push({
        '@type': 'BroadcastEvent',
        'name': `${channelName} Live Stream`,
        'description': description || `Live streaming on ${channelName}`,
        'isLiveBroadcast': true,
        'url': url,
        'location': {
          '@type': 'VirtualLocation',
          'url': url
        },
        'organizer': {
          '@id': `${this.siteUrl}/#organization`
        }
      });
    }

    this.updateSchema(graph);
  }

  /**
   * Reset to default global schema
   */
  resetSchema(): void {
    this.setGlobalSchema();
  }
}
