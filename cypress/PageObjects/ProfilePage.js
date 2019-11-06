/* eslint-disable no-undef */
class ProfilePage {
  get pageHeader() {
    return cy.get('h1[role=heading]', { timeout: 10000 })
  }

  get nameInput() {
    return cy.get('input[placeholder="Choose a Username"]', { timeout: 10000 })
  }

  get phoneInput() {
    return cy.get('input[placeholder="Add your Mobile"]', { timeout: 10000 })
  }

  get emailInput() {
    return cy.get('input[placeholder="Add your Email"]', { timeout: 10000 })
  }

  get profilePrivacyButton() {
    return cy.get('[data-focusable]', { timeout: 10000 }).eq(2)
  }

  get avatarDiv() {
    return cy.get('img[alt]', { timeout: 10000 })
  }

  // ** this button causes react decoder error sometimes ** //
  // get editProfileButton() {
  //     return cy.get('body').find('[style="font-family: gooddollar; font-size: 25px; font-style: normal;"]', { timeout: 10000 });
  // }

  openEditProfileButton() {
    cy.visit(Cypress.env('baseUrl') + 'AppNavigation/Profile/EditProfile')
    cy.wait(5000)
  }

  openProfilePage() {
    cy.visit(Cypress.env('baseUrl') + 'AppNavigation/Profile/Profile')
    cy.wait(5000)
  }
}

export default new ProfilePage()
