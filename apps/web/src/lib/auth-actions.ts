type SignOut = () => Promise<{ error: Error | null }>;

export async function signOutSession(signOut: SignOut) {
  const { error } = await signOut();
  if (error) throw new Error('Failed to sign out. Please try again.');
}
