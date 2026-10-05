import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation } from 'react-router';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { errorMessage } from '@/lib/api';
import { useAuth } from './auth-context';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner label="Restoring session" />;
  if (status === 'anonymous')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/** Sends signed-in users back to where they came from (or the shop). */
function useRedirectTarget() {
  const location = useLocation();
  return (location.state as { from?: string } | null)?.from ?? '/';
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Card className="mt-5">
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

const loginSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const { login, loginAsDemo, status } = useAuth();
  const target = useRedirectTarget();
  const [error, setError] = useState<string | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  if (status === 'authenticated') return <Navigate to={target} replace />;

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthCard title="Log in">
      <form
        className="space-y-4"
        noValidate
        onSubmit={handleSubmit((v) => run(() => login(v.email, v.password)))}
      >
        {error && <Alert>{error}</Alert>}
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" {...register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Log in
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          loading={demoLoading}
          onClick={async () => {
            setDemoLoading(true);
            await run(loginAsDemo);
            setDemoLoading(false);
          }}
        >
          Continue as demo user
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500">
        New here?{' '}
        <Link to="/register" className="font-medium text-brand-600 hover:underline">
          Create an account
        </Link>
      </p>
    </AuthCard>
  );
}

const registerSchema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(80),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters').max(72),
});
type RegisterValues = z.infer<typeof registerSchema>;

export function RegisterPage() {
  const { register: signUp, status } = useAuth();
  const target = useRedirectTarget();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({ resolver: zodResolver(registerSchema) });

  if (status === 'authenticated') return <Navigate to={target} replace />;

  const onSubmit = async (values: RegisterValues) => {
    setError(null);
    try {
      await signUp(values);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthCard title="Create your account">
      <form className="space-y-4" noValidate onSubmit={handleSubmit(onSubmit)}>
        {error && <Alert>{error}</Alert>}
        <Field label="Your name" error={errors.name?.message}>
          <Input autoComplete="name" {...register('name')} />
        </Field>
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" {...register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand-600 hover:underline">
          Log in
        </Link>
      </p>
    </AuthCard>
  );
}
